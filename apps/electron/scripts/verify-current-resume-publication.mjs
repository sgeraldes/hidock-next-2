import { openValidationClient } from './device-validation-client.mjs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { existsSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs'
import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'

const directory = resolve('node_modules/.cache/completion630-runtime')
const fixtureName = 'controlled-native-voice-1791841283983.private.wav'
const fixturePath = join(directory, fixtureName)
const metadataPath = join(directory, fixtureName.replace(/\.wav$/, '.json'))
const profile = JSON.parse(await readFile(join(directory, 'isolated-profile.private.json'), 'utf8'))
const dataPath = resolve(profile.dataPath)
const dataRelative = relative(directory, dataPath)
if (!dataRelative || dataRelative.startsWith('..') || isAbsolute(dataRelative)) throw Error('Isolated validation library is required')
const recordings = join(dataPath, 'recordings')
const dbPath = join(dataPath, 'data', 'hidock.db')
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
const expectedSize = 2_027_676
const expectedSha256 = 'eab76bd25d6ff64c7aeb7bab1574daa40c0e62639bfd29aad545e8c3fa19db9e'

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
function mappedName(filename) { return filename.replace(/\.hda$/i, '.wav') }
function numberedName(filename, attempt) {
  if (attempt === 0) return filename
  const extension = extname(filename)
  return `${filename.slice(0, filename.length - extension.length)}-${attempt}${extension}`
}
function firstFreeCandidate(filename) {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const path = join(recordings, numberedName(filename, attempt))
    try { lstatSync(path) } catch (error) { if (error?.code === 'ENOENT') return { path, attempt }; throw error }
  }
  throw Error('No isolated destination name was available for the collision sentinel')
}
function setSentinel(path, bytes) {
  let fd
  let created = false
  try {
    fd = openSync(path, 'wx', 0o600)
    created = true
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already closed */ } }
    if (created) { try { unlinkSync(path) } catch { /* remove only our incomplete sentinel */ } }
    throw error
  }
}
function candidateExists(filename, attempt) {
  try { lstatSync(join(recordings, numberedName(filename, attempt))); return true }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

if (metadata.totalBytes !== expectedSize || metadata.sha256 !== expectedSha256 || metadata.owned == null ||
    basename(metadata.owned) !== metadata.owned || /[\\/]/.test(metadata.owned)) throw Error('Controlled fixture metadata changed')
if (await stat(fixturePath).then(value => value.size) !== expectedSize || await sha256File(fixturePath) !== expectedSha256) {
  throw Error('Controlled fixture size or SHA-256 changed')
}
await mkdir(recordings, { recursive: true })
if (!existsSync(dbPath)) throw Error('Isolated validation database is unavailable')

const filename = metadata.owned
const outputName = mappedName(filename)
const sentinelCandidate = firstFreeCandidate(outputName)
const sentinelBytes = Buffer.from('completion630 isolated no-overwrite sentinel v1\n', 'ascii')
const sentinelSha256 = createHash('sha256').update(sentinelBytes).digest('hex')
const evidence = {
  observedAt: new Date().toISOString(),
  boundary: 'updated-development-app/physical-H1E-393988/isolated-validation-library',
  fixture: { filenameRedacted: true, bytes: expectedSize, sha256: expectedSha256 },
  originalLibraryMutated: false,
  providerRequests: 0,
  deviceWritesRequested: 0,
  sdDeletesRequested: 0,
}
let client
let sentinelPath
let sentinelOwned = false
let stage = 'preflight'

try {
  client = await openValidationClient()
  const preflight = await client.evaluate(`(async()=>{
    const api=window.electronAPI,j=api?.jensen,d=api?.downloadService
    if(!j||!d)throw Error('Trusted preload API is unavailable')
    if(!await j.isConnected()&&!await j.connect())throw Error('Physical device connection unavailable')
    await j.getDeviceInfo()
    const state=await j.getState()
    if(!state?.connected||state.model!=='hidock-h1e'||state.versionNumber!==393988||state.versionCode!=='6.3.4')throw Error('Expected connected physical 393988 (6.3.4)')
    const listing=await j.listFilesDetailed()
    if(listing.status!=='complete')throw Error('Physical source catalog is incomplete')
    const matches=listing.files.filter(file=>file.name===${JSON.stringify(filename)}&&file.length===${expectedSize})
    if(matches.length!==1)throw Error('Controlled private source is not uniquely present on the device')
    const diagnostics=await j.getProtocolDiagnostics()
    if(diagnostics.currentCommand!==null||diagnostics.fileStreamPending)throw Error('Device owner is not idle before acceptance')
    const prior=await d.getState(),item=prior.queue.find(value=>value.filename===${JSON.stringify(filename)})
    if(item&&['pending','downloading','cancelling'].includes(item.status))throw Error('Controlled source already has active queue work')
    if(item)await d.dismiss(${JSON.stringify(filename)})
    return {model:state.model,versionNumber:state.versionNumber,versionCode:state.versionCode,sourceBytes:matches[0].length,ownerIdle:true}
  })()`)
  evidence.device = { model: preflight.model, firmware: preflight.versionNumber, versionCode: preflight.versionCode,
    sourceBytes: preflight.sourceBytes, sourceFilenameRedacted: true, ownerIdleBefore: preflight.ownerIdle }

  // Clear only stale markers for this controlled source in the isolated DB. The
  // actual queue item is created below through the public downloadService API.
  stage = 'isolated-queue-preparation'
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    const names = [...new Set([filename, filename.replace(/\.hda$/i, '.mp3'), filename.replace(/\.hda$/i, '.wav')])]
    db.transaction(() => {
      for (const name of names) {
        db.prepare('DELETE FROM synced_files WHERE original_filename=?').run(name)
        db.prepare('DELETE FROM download_queue WHERE filename=?').run(name)
        db.prepare("UPDATE recordings SET file_path=NULL,on_local=0,location='device-only' WHERE filename=? OR original_filename=?").run(name, name)
      }
    })()
  } finally { db.close() }

  stage = 'late-collision-download'
  const collision = new Promise(resolveCollision => {
    let settled = false
    let result
    let failure
    let stagedCheckpointName
    const operation = client.evaluate(`(async()=>{
      const api=window.electronAPI,j=api.jensen,d=api.downloadService,name=${JSON.stringify(filename)},size=${expectedSize}
      const queued=await d.queueDownloads([{filename:name,size}])
      if(!queued.queued.includes(name))throw Error('Public queue refused controlled source')
      const before=await j.getProtocolDiagnostics(),download=await j.downloadToLibrary(name,size),after=await j.getProtocolDiagnostics()
      return {download,inboundBytes:after.inboundBytes-before.inboundBytes,ownerIdle:after.currentCommand===null&&!after.fileStreamPending}
    })()`, 120000)
    operation.then(value => { result = value; settled = true }, error => { failure = error; settled = true })
    void (async () => {
      let injectionFailure
      while (!settled) {
        if (!sentinelPath && !injectionFailure) {
          try {
            for (const name of await readdir(recordings)) {
              if (!/^\.hidock-resume-[a-f0-9]{64}\.json$/.test(name)) continue
              const checkpoint = JSON.parse(await readFile(join(recordings, name), 'utf8'))
              if (checkpoint.identity?.filename !== filename || checkpoint.identity?.size !== expectedSize || checkpoint.committed !== expectedSize) continue
              const partial = join(recordings, name.replace(/\.json$/, '.partial'))
              let partialStat
              try { partialStat = await stat(partial) } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
              if (partialStat.size !== expectedSize || await sha256File(partial) !== expectedSha256) continue
              sentinelPath = sentinelCandidate.path
              setSentinel(sentinelPath, sentinelBytes)
              for (let attempt = 0; attempt < sentinelCandidate.attempt; attempt++) {
                if (!candidateExists(outputName, attempt)) throw Error('A lower destination name became free before the late collision')
              }
              sentinelOwned = true
              stagedCheckpointName = name
              evidence.collision = { injectedAfterCompleteStage: true, sentinelBytes: sentinelBytes.length,
                sentinelSha256, destinationIndex: sentinelCandidate.attempt, stagedBytes: expectedSize, stagedSha256: expectedSha256 }
              break
            }
          } catch (error) { injectionFailure = error }
        }
        if (!settled) await delay(5)
      }
      resolveCollision({ result, failure, injectionFailure, stagedCheckpointName })
    })()
  })
  const first = await collision
  if (first.failure) throw first.failure
  evidence.collisionResult = { success: first.result?.download?.success === true,
    errorObserved: typeof first.result?.download?.error === 'string', ownerIdle: first.result?.ownerIdle,
    inboundBytes: first.result?.inboundBytes }
  if (!sentinelOwned || !evidence.collision?.injectedAfterCompleteStage) {
    evidence.blocker = first.injectionFailure ? 'CDP preload could not create the sentinel after full staging and before publication' :
      'Development app published before the CDP filesystem watcher could create the late sentinel'
    throw Error(evidence.blocker)
  }
  if (!first.result.ownerIdle) throw Error('Device owner did not settle after collision publication')

  stage = 'collision-and-checkpoint-readback'
  const sentinelStillSet = (await stat(sentinelPath)).size === sentinelBytes.length && await sha256File(sentinelPath) === sentinelSha256
  evidence.collision.sentinelUnchanged = sentinelStillSet
  evidence.collision.destinationRedacted = true
  if (!sentinelStillSet) throw Error('Late destination sentinel changed during publication')

  let completion = first.result
  let resumedFromCompleteCheckpoint = false
  if (!completion.download.success) {
    if (!/Cannot publish/i.test(completion.download.error ?? '') || !first.stagedCheckpointName) {
      throw Error('Publication failed outside the observed late destination collision')
    }
    const checkpointPath = join(recordings, first.stagedCheckpointName)
    const partialPath = checkpointPath.replace(/\.json$/, '.partial')
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
    evidence.checkpointAfterCollision = { committed: checkpoint.committed, diskBytes: (await stat(partialPath)).size,
      sha256: checkpoint.sha256, diskSha256: await sha256File(partialPath) }
    if (checkpoint.committed !== expectedSize || evidence.checkpointAfterCollision.diskBytes !== expectedSize ||
        checkpoint.sha256 !== expectedSha256 || evidence.checkpointAfterCollision.diskSha256 !== expectedSha256) {
      throw Error('Collision failure did not retain the complete verified resume stage')
    }
    // Remove only our verified sentinel, then resume the already-complete owned
    // stage through the same public path. The resume engine performs its bounded
    // source probes but should not transfer the full file again.
    await unlink(sentinelPath)
    sentinelOwned = false
    resumedFromCompleteCheckpoint = true
    stage = 'publish-complete-resume-stage'
    completion = await client.evaluate(`(async()=>{
      const api=window.electronAPI,j=api.jensen,d=api.downloadService,name=${JSON.stringify(filename)},size=${expectedSize}
      if(!await d.dismiss(name))throw Error('Could not dismiss only the failed controlled queue item')
      const queued=await d.queueDownloads([{filename:name,size}])
      if(!queued.queued.includes(name))throw Error('Public queue refused complete staged source')
      const before=await j.getProtocolDiagnostics(),download=await j.downloadToLibrary(name,size),after=await j.getProtocolDiagnostics()
      return {download,inboundBytes:after.inboundBytes-before.inboundBytes,ownerIdle:after.currentCommand===null&&!after.fileStreamPending}
    })()`)
  }
  if (!completion.download.success || !completion.ownerIdle || !resolve(completion.download.filePath).startsWith(resolve(recordings) + '\\')) {
    throw Error('Completed checkpoint could not publish through the public library route')
  }
  const publishedPath = resolve(completion.download.filePath)
  const published = { bytes: (await stat(publishedPath)).size, sha256: await sha256File(publishedPath) }
  evidence.published = { ...published, equalsFixture: published.bytes === expectedSize && published.sha256 === expectedSha256,
    destinationRedacted: true }
  evidence.publicationPathDiffersFromSentinel = publishedPath !== sentinelPath
  if (!resumedFromCompleteCheckpoint && (!evidence.publicationPathDiffersFromSentinel || !evidence.collision.sentinelUnchanged)) {
    throw Error('No-overwrite collision did not preserve the sentinel and select another name')
  }
  evidence.resumedFromCompleteCheckpoint = resumedFromCompleteCheckpoint
  evidence.resumeRevalidationInboundBytes = completion.inboundBytes
  evidence.resumeDidNotRedownloadFullFile = resumedFromCompleteCheckpoint ? completion.inboundBytes < expectedSize : null
  evidence.checkpointRemoved = !(await readdir(recordings)).some(name => name === first.stagedCheckpointName ||
    name === first.stagedCheckpointName?.replace(/\.json$/, '.partial') || name === first.stagedCheckpointName?.replace(/\.json$/, '.json.next'))
  evidence.ownerIdle = completion.ownerIdle
  const verifyDb = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = verifyDb.prepare('SELECT file_path,file_size FROM synced_files WHERE original_filename=?').get(filename)
    evidence.sqliteReadback = !!row && resolve(row.file_path) === publishedPath && row.file_size === expectedSize
  } finally { verifyDb.close() }
  evidence.passed = evidence.collision.injectedAfterCompleteStage && evidence.published.equalsFixture &&
    evidence.checkpointRemoved && evidence.ownerIdle && evidence.sqliteReadback &&
    (resumedFromCompleteCheckpoint ? evidence.collision.sentinelUnchanged && evidence.checkpointAfterCollision?.diskSha256 === expectedSha256 && evidence.resumeDidNotRedownloadFullFile :
      evidence.collisionResult.success && evidence.collision.sentinelUnchanged && evidence.publicationPathDiffersFromSentinel)
} catch (error) {
  evidence.stage = stage
  evidence.failure = error instanceof Error ? error.message.replaceAll(filename, '[private-source]') : 'Acceptance failed'
  process.exitCode = 1
} finally {
  evidence.stage ??= stage
  const output = join(directory, `current-resume-publication-${Date.now()}.json`)
  await writeFile(output, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  client?.close()
}
if (!evidence.passed) process.exitCode = 1
