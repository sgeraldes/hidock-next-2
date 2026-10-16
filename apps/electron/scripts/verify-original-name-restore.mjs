/** Explicit root-operated RSTR2 validation. Never opens USB or creates DAO rows. */
import { openValidationClient } from './device-validation-client.mjs'
import { open, mkdir, lstat, readFile, rename, unlink, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const CACHE = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/.cache/completion630-runtime')
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const modes = ['begin', 'append', 'commit-step', 'status', 'recover-step', 'verify-readback']
const methods = { begin: 'beginOwnedRecordingRestore', append: 'appendOwnedRecordingRestore', 'commit-step': 'verifyOwnedRecordingRestoreStep',
  status: 'getOwnedRecordingRestoreStatus', 'recover-step': 'recoverOwnedRecordingRestoreStep', 'verify-readback': 'verifyOwnedRecordingRestoreReadback' }
const boolFlags = ['consent-owned-write', 'audio-quiescent-confirmed', 'operator-paced-loop', 'self-test']
const valueFlags = ['mode', 'recording-id', 'total-bytes', 'expected-sha256', 'checkpoint-id', 'session-id', 'max-ops', 'pace-ms', 'max-seconds']
function options(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (!argv[i].startsWith('--') || Object.hasOwn(args, key)) throw Error('invalid-arguments')
    if (boolFlags.includes(key)) args[key] = true
    else if (valueFlags.includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i]
    else throw Error('invalid-arguments')
  }
  if (args['self-test']) return args
  if (!modes.includes(args.mode) || !UUID.test(args['recording-id'] ?? '') || !UUID.test(args['checkpoint-id'] ?? '') ||
    !/^\d+$/.test(args['total-bytes'] ?? '') || !/^[a-f0-9]{64}$/i.test(args['expected-sha256'] ?? '')) throw Error('invalid-arguments')
  args.total = Number(args['total-bytes']); args.maxOps = Number(args['max-ops'] ?? 1); args.pace = Number(args['pace-ms'] ?? 25)
  args.maxSeconds = Number(args['max-seconds'] ?? 300)
  if (!Number.isSafeInteger(args.total) || args.total < 0 || args.total > 0x7fffffff || !Number.isSafeInteger(args.maxOps) || args.maxOps < 1 || args.maxOps > 20000 ||
    !Number.isSafeInteger(args.pace) || args.pace < 10 || args.pace > 1000 || !Number.isSafeInteger(args.maxSeconds) || args.maxSeconds < 1 || args.maxSeconds > 3600 ||
    args.maxOps > 1 && (!args['operator-paced-loop'] || !['append', 'commit-step'].includes(args.mode))) throw Error('invalid-bounds-or-loop-consent')
  if (['begin', 'append', 'commit-step', 'recover-step'].includes(args.mode) && (!args['consent-owned-write'] || !args['audio-quiescent-confirmed'])) throw Error('explicit-write-and-audio-consent-required')
  if (args['session-id'] && (!UUID.test(args['session-id']) || args.mode !== 'status')) throw Error('session-reference-only-for-explicit-status')
  return args
}
function digest(value) {
  if (Array.isArray(value) && value.length === 32 || value && typeof value === 'object' && Object.keys(value).length === 32 && Object.keys(value).every(k => /^(\d|[12]\d|3[01])$/.test(k))) {
    const bytes = Array.from({ length: 32 }, (_, i) => value[i])
    if (bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) return Buffer.from(bytes).toString('hex')
  }
  return null
}
function confirmed(result, checkpoint) {
  const reply = result?.reply, m = reply?.metadata
  return (!!result && result.status === 'reply' || result?.status === 'restore-verified') ?
    ['accepted','rejected'].includes(reply?.acknowledgement) && Number.isInteger(reply.stateCode) && reply.stateCode >= 0 && reply.stateCode <= 7 &&
    Number.isInteger(reply.reasonCode) && reply.reasonCode >= 0 && reply.reasonCode <= 14 &&
    reply?.checkpoint === 'validated-binding' && m?.totalBytes === checkpoint.totalBytes && digest(m.sourceSha256) === checkpoint.expectedSha256 &&
    Number.isSafeInteger(m.uploadedBytes) && m.uploadedBytes >= 0 && m.uploadedBytes <= checkpoint.totalBytes &&
    Number.isSafeInteger(m.verifiedBytes) && m.verifiedBytes >= 0 && m.verifiedBytes <= m.uploadedBytes : false
}
async function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`, bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > 16384) throw Error('checkpoint-bound-exceeded')
  const file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  try { await rename(temp, path) } catch { await unlink(temp); throw Error('checkpoint-publication-failed') }
}
async function guard(client) {
  return client.evaluate(`(async()=>{
    const j=window.electronAPI.jensen;
    if(!await j.isConnected())return {safe:false};
    const audio=await j.getAudioDiagnostics(),beforeBus=await j.getProtocolDiagnostics();
    if(audio?.session?.status!=='idle'||beforeBus?.queuedCommands!==0||beforeBus.currentCommand!==null||beforeBus.activeDownload||beforeBus.fileStreamPending)return {safe:false};
    const info=await j.getDeviceInfo();
    if(info?.model!=='hidock-h1e'||info.versionNumber!==393988||info.versionCode!=='6.3.4')return {safe:false};
    const native=await j.getNativeRecordingStatus(),bus=await j.getProtocolDiagnostics();
    return {safe:native?.recording===null&&audio?.session?.status==='idle'&&bus?.queuedCommands===0&&bus.currentCommand===null&&!bus.activeDownload&&!bus.fileStreamPending,
      appEpoch:performance.timeOrigin};
  })()`,30000)
}
async function run(args) {
  await mkdir(CACHE, { recursive: true })
  const cache = await lstat(CACHE); if (!cache.isDirectory() || cache.isSymbolicLink()) throw Error('private-checkpoint-folder-unavailable')
  const path = join(CACHE, `rstr2-restore-${args['checkpoint-id'].toLowerCase()}.private.json`), lockPath = `${path}.lock`
  const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.sync()
  let client, checkpoint, attempted = 0, verifiedReadback = false
  try {
    if (args.mode === 'begin') {
      try { await lstat(path); throw Error('existing-begin-checkpoint-no-retry') } catch (error) { if (error.code !== 'ENOENT') throw error }
      checkpoint = { schema: 1, checkpointId: args['checkpoint-id'].toLowerCase(), recordingId: args['recording-id'].toLowerCase(), totalBytes: args.total,
        expectedSha256: args['expected-sha256'].toLowerCase(), sessionId: null, appEpoch: null, requiresStatus: true, lastConfirmed: null, inFlight: null }
    } else {
      const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('invalid-private-checkpoint')
      checkpoint = JSON.parse(await readFile(path, 'utf8'))
      if (checkpoint.schema !== 1 || checkpoint.checkpointId !== args['checkpoint-id'].toLowerCase() || checkpoint.recordingId !== args['recording-id'].toLowerCase() ||
        checkpoint.totalBytes !== args.total || checkpoint.expectedSha256 !== args['expected-sha256'].toLowerCase()) throw Error('checkpoint-binding-mismatch')
      if (args['session-id']) {
        if (checkpoint.sessionId && checkpoint.sessionId !== args['session-id'].toLowerCase()) throw Error('session-reference-mismatch')
        checkpoint.sessionId = args['session-id'].toLowerCase()
      }
      if (!checkpoint.sessionId || !UUID.test(checkpoint.sessionId)) throw Error('explicit-owned-session-reference-required')
    }
    client = await openValidationClient()
    const deadline = Date.now() + args.maxSeconds * 1000
    for (let i = 0; i < args.maxOps; i++) {
      if (Date.now() >= deadline) break // Safe between-operations pause; no retry or abort.
      const ready = await guard(client)
      if (!ready?.safe) throw Error('future-version-native-audio-or-bus-not-idle')
      if (Date.now() >= deadline) break
      if (args.mode !== 'begin' && args.mode !== 'status' && (checkpoint.requiresStatus || checkpoint.appEpoch !== ready.appEpoch)) throw Error('explicit-status-required-before-continuation')
      const progress = checkpoint.lastConfirmed
      if (args.mode === 'append' && (progress?.acknowledgement !== 'accepted' || progress.stateCode !== 1)) throw Error('confirmed-receiving-state-required')
      if (args.mode === 'append' && progress.uploadedBytes === args.total) break
      if (args.mode === 'commit-step' && (progress?.acknowledgement !== 'accepted' || progress.uploadedBytes !== args.total || ![1, 2, 3, 4].includes(progress.stateCode))) throw Error('complete-confirmed-upload-required')
      if (args.mode === 'recover-step' && progress?.recovery !== 'explicit-recover-step-required' && progress?.stateCode !== 6) throw Error('explicit-recovery-status-required')
      if (args.mode === 'verify-readback' && (progress?.acknowledgement !== 'accepted' || progress?.stateCode !== 5)) throw Error('finished-owned-status-required')
      const offset = args.mode === 'append' ? progress.uploadedBytes : null, count = offset === null ? null : Math.min(1024, args.total - offset)
      checkpoint.inFlight = { operation: args.mode, offset, count, startedAt: new Date().toISOString() }; checkpoint.requiresStatus = true
      await save(path, checkpoint) // fsynced before every requested RSTR2 operation.
      const consent = { ownedRecordingRestoreConsent: true, audioQuiescent: true }
      const parameters = args.mode === 'begin' ? [checkpoint.recordingId, consent] : args.mode === 'append' ? [checkpoint.sessionId, { offset, count }, consent] :
        ['commit-step', 'recover-step'].includes(args.mode) ? [checkpoint.sessionId, consent] : [checkpoint.sessionId]
      attempted++
      const result = await client.evaluate(`(async()=>{
        const r=await window.electronAPI.jensen[${JSON.stringify(methods[args.mode])}](...${JSON.stringify(parameters)});
        if(r?.reply?.metadata?.sourceSha256)r.reply.metadata.sourceSha256=Array.from(r.reply.metadata.sourceSha256);
        return r;
      })()`,120000)
      if (result?.sessionId && UUID.test(result.sessionId)) {
        if (checkpoint.sessionId && checkpoint.sessionId !== result.sessionId.toLowerCase()) throw Error('response-session-mismatch')
        checkpoint.sessionId = result.sessionId.toLowerCase()
      }
      if (result?.filename) {
        if (checkpoint.originalFilename && checkpoint.originalFilename !== result.filename) throw Error('response-original-name-mismatch')
        checkpoint.originalFilename = result.filename // Private only; never accepted as a caller-selected name.
      }
      if (!confirmed(result, checkpoint)) { await save(path, checkpoint); throw Error('unconfirmed-outcome-explicit-status-required') }
      const reply = result.reply
      checkpoint.lastConfirmed = { acknowledgement: reply.acknowledgement, stateCode: reply.stateCode, reasonCode: reply.reasonCode,
        recovery: reply.recovery, uploadedBytes: reply.metadata.uploadedBytes, verifiedBytes: reply.metadata.verifiedBytes }
      checkpoint.requiresStatus = reply.recovery === 'manual-investigation-required' || reply.recovery === 'read-only-status-required'
      checkpoint.inFlight = null; checkpoint.appEpoch = ready.appEpoch
      await save(path, checkpoint)
      if (reply.acknowledgement !== 'accepted' && !(args.mode === 'status' && reply.recovery === 'explicit-recover-step-required')) throw Error('native-rejected-no-automatic-continuation')
      if (args.mode === 'verify-readback' && (result.status !== 'restore-verified' || result.restoreVerified !== true || result.deviceFinished !== true)) throw Error('full-source-sha-readback-not-verified')
      if (args.mode === 'verify-readback') verifiedReadback = true
      if (reply.stateCode === 5 || !['append', 'commit-step'].includes(args.mode)) break
      await new Promise(resolve => setTimeout(resolve, args.pace))
    }
    return { status: attempted ? 'bounded-operator-phase-confirmed' : 'no-rstr2-operation-budget-expired-or-already-appended', mode: args.mode, checkpointReference: checkpoint.checkpointId, operationsAttempted: attempted,
      stateCode: checkpoint.lastConfirmed?.stateCode, uploadedBytes: checkpoint.lastConfirmed?.uploadedBytes, verifiedBytes: checkpoint.lastConfirmed?.verifiedBytes,
      totalBytes: args.total, restoreVerified: verifiedReadback, requiresExplicitStatus: checkpoint.requiresStatus,
      providerRequests: 0, overwriteDeleteFlashFactoryRequests: 0 }
  } finally { client?.close(); await lock.close(); await unlink(lockPath) }
}
async function main() {
  try {
    const args = options(process.argv.slice(2))
    if (args['self-test']) {
      assert.throws(() => options(['--mode', 'begin']))
      assert.equal(digest(Array(32).fill(2)), '02'.repeat(32))
      assert.equal(confirmed({ status: 'reply', reply: { checkpoint: 'unavailable-preoperation-hint' } }, { totalBytes: 1 }), false)
      const basic = ['--mode', 'append', '--recording-id', randomUUID(), '--checkpoint-id', randomUUID(), '--total-bytes', '1025', '--expected-sha256', '01'.repeat(32), '--consent-owned-write', '--audio-quiescent-confirmed']
      assert.equal(options(basic).maxOps, 1)
      assert.throws(() => options([...basic, '--max-ops', '2']))
      assert.equal(options([...basic, '--max-ops', '2', '--operator-paced-loop']).maxOps, 2)
      const folder = await mkdtemp(join(tmpdir(), 'hidock-rstr2-harness-'))
      // Checked before use: the cleanup below removes this folder recursively.
      if (dirname(resolve(folder)) !== resolve(tmpdir()) || !folder.startsWith(join(tmpdir(), 'hidock-rstr2-harness-'))) throw Error('unsafe-selftest-cleanup')
      try {
        const path = join(folder, 'owned.private.json'); await save(path, { inFlight: 'append', requiresStatus: true });
        assert.equal(JSON.parse(await readFile(path, 'utf8')).requiresStatus, true)
        await save(path, { inFlight: null, requiresStatus: false }); assert.equal(JSON.parse(await readFile(path, 'utf8')).inFlight, null)
        await assert.rejects(save(path, { oversized: 'x'.repeat(16385) }))
      } finally {
        await rm(folder, { recursive: true, force: true })
      }
      console.log(JSON.stringify({ status: 'passed-offline-parser-and-real-checkpoint-tests', hardwareCalls: 0 })); return
    }
    console.log(JSON.stringify(await run(args)))
  } catch {
    console.log(JSON.stringify({ status: 'stopped-no-retry', continuation: 'Inspect private checkpoint; use explicit STATUS before any further mutation.',
      providerRequests: 0, overwriteDeleteFlashFactoryRequests: 0 })); process.exitCode = 1
  }
}
await main()
