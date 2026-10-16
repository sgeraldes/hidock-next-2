/**
 * Read-only transfer-contract verification on current custom firmware (393988), run through the sole trusted
 * development application. Every request is fixed, bounded and sent only through the existing preload API:
 * detailed listing, one fixture-centered page, one prefix, boundary/EOF ranges and one whole-file download of the OWNED fixture.
 * No deletes, settings, recording control, library publication, provider, firmware or storage writes.
 *
 *   node scripts/verify-current-transfer-contracts.mjs --confirm-read-only-transfer [--input <private fixture report>]
 */
import { openValidationClient } from './device-validation-client.mjs'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, relative, resolve } from 'node:path'

const CACHE = resolve(fileURLToPath(new URL('../node_modules/.cache/completion630-runtime/', import.meta.url)))
const RUNTIME = resolve(fileURLToPath(new URL('../../../research/rea/completion630-lab/runtime/', import.meta.url)))
const DEFAULT_INPUT = join(CACHE, 'controlled-native-voice-1791841283983.private.json')
const EXPECTED_VERSION = 393988
const EXPECTED_VERSION_CODE = '6.3.4'
const MAX_DOWNLOAD_BYTES = 3 * 1024 * 1024
const MAX_READ_BYTES = 16360
const OVERALL_DEADLINE_MS = 8 * 60 * 1000
const PREFIX_COUNT = 52
const BOUNDARY_OFFSET = 65535
const BOUNDARY_COUNT = 52
const EOF_COUNT = 52
const MINIMUM_FIXTURE_BYTES = BOUNDARY_OFFSET + BOUNDARY_COUNT
const PAGE_SIZE = 128
const MAX_PAGE_REQUESTS = 5
const ENTRY_FIELDS = ['n', 'l', 's', 'd', 't', 'u', 'v']
const ALLOWED_METHODS = new Set([
  'isConnected', 'connect', 'getDeviceInfo', 'getNativeRecordingStatus', 'getAudioDiagnostics', 'getProtocolDiagnostics',
  'listFilesDetailed', 'listFilesPage', 'readFileRange', 'readFilePrefix', 'downloadFile',
  'onDownloadChunk', 'onDownloadProgress', 'cancelDownload',
])
const FORBIDDEN = /\b(deleteFile|formatCard|setTime|setAutoRecord|setSettings|downloadToLibrary|resumeToLibrary|startNative\w*|stopNative\w*|startRecording|stopRecording|upload\w*|firmware\w*|restore\w*|reset\w*|flash\w*)\b/i

const argv = process.argv.slice(2)
if (!argv.includes('--confirm-read-only-transfer')) throw Error('Explicit read-only transfer verification confirmation required')
const inputFlag = argv.indexOf('--input')
if (inputFlag >= 0 && !argv[inputFlag + 1]) throw Error('--input needs a path')
const inputPath = resolve(inputFlag >= 0 ? argv[inputFlag + 1] : DEFAULT_INPUT)
const inside = (root, path) => { const value = relative(root, path); return value !== '' && !value.startsWith('..') && !isAbsolute(value) }
if (!inside(CACHE, inputPath) || !inputPath.endsWith('.private.json')) throw Error('Fixture report must be a private report inside the runtime cache')

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const checks = {}
const failures = []
const check = (name, ok, detail) => { checks[name] = Boolean(ok); if (!ok) failures.push(detail ? `${name}: ${detail}` : name); return Boolean(ok) }
const must = (name, ok, detail) => { if (!check(name, ok, detail)) throw Error(`Required check failed: ${name}`) }
const calls = {}
const tally = (...names) => {
  for (const name of names) {
    if (!ALLOWED_METHODS.has(name)) throw Error(`Method outside the read-only allowlist: ${name}`)
    calls[name] = (calls[name] ?? 0) + 1
  }
}
const stateCalls = ['isConnected', 'getDeviceInfo', 'getNativeRecordingStatus', 'getAudioDiagnostics', 'getProtocolDiagnostics']

const PRELUDE = `
const j=window.electronAPI.jensen;
const within=(promise,ms,label)=>{let timer;return Promise.race([promise,new Promise((_,fail)=>{timer=setTimeout(()=>fail(Error(label+' timed out')),ms)})]).finally(()=>clearTimeout(timer))};
const kind=value=>Object.prototype.toString.call(value);
const toBytes=value=>{
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength));
  if(kind(value)==='[object ArrayBuffer]')return new Uint8Array(value.slice(0));
  throw Error('Unexpected binary payload '+kind(value));
};
const b64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));return btoa(text)};
const cancelQuietly=async()=>{try{await within(j.cancelDownload(),20000,'cancelDownload')}catch(error){return String(error&&error.message||error)}return null};
const entry=f=>({n:f.name,l:f.length,s:f.signature,d:f.createDate,t:f.createTime,u:f.duration,v:f.version});
const state=async()=>{
  const connected=await within(j.isConnected(),20000,'isConnected');
  const info=await within(j.getDeviceInfo(),20000,'getDeviceInfo');
  const native=await within(j.getNativeRecordingStatus(),20000,'getNativeRecordingStatus');
  const audio=await within(j.getAudioDiagnostics(),20000,'getAudioDiagnostics');
  const diag=await within(j.getProtocolDiagnostics(),20000,'getProtocolDiagnostics');
  return {connected:!!connected,model:info?.model??null,versionNumber:info?.versionNumber??null,versionCode:info?.versionCode??null,
    nativeIdle:native?.recording===null,audioIdle:audio?.session?.status==='idle',audioStatus:audio?.session?.status??null,
    sessionId:diag?.connectionSessionId??null};
};
`

const STATE_BODY = 'return await state();'
const IDENTITY_BODY = `
let s=await state();
const already=s.connected;
if(!already){
  if(!await within(j.connect(),60000,'connect'))throw Error('Expected dock unavailable');
  s=await state();
}
return {...s,already,stateReads:already?1:2};
`
const CATALOG_BODY = `
const r=await within(j.listFilesDetailed(),A.timeout,'listFilesDetailed');
return {status:r?.status??null,expectedCount:r?.expectedCount??null,parsedCount:r?.parsedCount??null,reason:r?.reason??null,
  files:Array.isArray(r?.files)?r.files.map(entry):null};
`
const PAGE_BODY = `
const r=await within(j.listFilesPage(A.first,A.count),A.timeout,'listFilesPage');
return {status:r?.status??null,reason:r?.reason??null,firstIndex:r?.firstIndex??null,requestedCount:r?.requestedCount??null,
  totalCount:r?.totalCount??null,expectedCount:r?.expectedCount??null,parsedCount:r?.parsedCount??null,
  files:Array.isArray(r?.files)?r.files.map(entry):null};
`
const READ_BODY = `
try{
  const data=await within(A.prefix?j.readFilePrefix(A.name,A.count):j.readFileRange(A.name,A.offset,A.count),A.timeout,'read');
  const bytes=toBytes(data);
  return {length:bytes.length,b64:b64(bytes),kind:kind(data)};
}catch(error){
  const message=String(error&&error.message||error);
  if(/timed out/.test(message))return {timedOut:true,cancelMessage:await cancelQuietly()};
  throw error;
}
`
const DOWNLOAD_BODY = `
const chunks=[],progress=[];
const proof={chunkKeys:new Set(),chunkKinds:new Set(),progressKeys:new Set(),progressTypes:new Set(),foreignChunks:0,badChunks:0,foreignProgress:0};
let retained=0,chunkEvents=0,chunkTotal=0,chunkMin=null,chunkMax=0,overflow=false,cancelMessage=null,returned=null,failure=null,stopsCalled=0,cancels=0;
let stopChunk=null,stopProgress=null;
const cancel=()=>{cancels++;return cancelQuietly()};
try{
  stopChunk=j.onDownloadChunk(event=>{
    proof.chunkKeys.add(event&&typeof event==='object'?Object.keys(event).sort().join(','):kind(event));
    if(!event||event.filename!==A.name){proof.foreignChunks++;return}
    let bytes;
    try{bytes=toBytes(event.data)}catch(error){proof.badChunks++;return}
    proof.chunkKinds.add(kind(event.data));
    chunkEvents++;chunkTotal+=bytes.length;chunkMin=chunkMin===null?bytes.length:Math.min(chunkMin,bytes.length);chunkMax=Math.max(chunkMax,bytes.length);
    if(retained+bytes.length>A.cap){if(!overflow){overflow=true;cancel().then(message=>{cancelMessage=message})}return}
    chunks.push(bytes);retained+=bytes.length;
  });
  stopProgress=j.onDownloadProgress(event=>{
    proof.progressKeys.add(event&&typeof event==='object'?Object.keys(event).sort().join(','):kind(event));
    if(!event||event.filename!==A.name){proof.foreignProgress++;return}
    proof.progressTypes.add(typeof event.bytesReceived+','+typeof event.totalBytes);
    if(progress.length<5000)progress.push({r:event.bytesReceived,t:event.totalBytes});
  });
  if(typeof stopChunk!=='function'||typeof stopProgress!=='function')throw Error('Download event subscriptions unavailable');
  returned=await within(j.downloadFile(A.name,A.size),A.timeout,'downloadFile');
  await new Promise(done=>setTimeout(done,A.settleMs));
}catch(error){
  failure=String(error&&error.message||error);
  if(/timed out/.test(failure))cancelMessage=await cancel();
}finally{
  for(const stop of [stopChunk,stopProgress])if(typeof stop==='function'){stop();stopsCalled++}
}
const all=new Uint8Array(retained);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.length}
let monotonic=true,maxReceived=0,withinTotal=true;
for(let i=0;i<progress.length;i++){
  if(i>0&&progress[i].r<progress[i-1].r)monotonic=false;
  maxReceived=Math.max(maxReceived,progress[i].r);
  if(progress[i].r>progress[i].t||progress[i].t!==A.size)withinTotal=false;
}
return {returned,failure,cancelMessage,cancels,overflow,stopsCalled,chunkEvents,chunkTotal,chunkMin,chunkMax,retained,
  b64:failure||overflow?null:b64(all),
  proof:{chunkKeys:[...proof.chunkKeys],chunkKinds:[...proof.chunkKinds],progressKeys:[...proof.progressKeys],progressTypes:[...proof.progressTypes],
    foreignChunks:proof.foreignChunks,badChunks:proof.badChunks,foreignProgress:proof.foreignProgress},
  progress:{events:progress.length,first:progress[0]?.r??null,final:progress.length?progress[progress.length-1].r:null,monotonic,maxReceived,withinTotal,
    totalValues:[...new Set(progress.map(p=>p.t))]}};
`
const PROTOCOL_BODY = `
const d=await within(j.getProtocolDiagnostics(),20000,'getProtocolDiagnostics');
const events=Array.isArray(d?.events)?d.events:[];
const out=events.filter(e=>e.kind==='out'&&e.connectionSessionId===d.connectionSessionId&&e.atMs>=A.since);
const histogram={};let maxPayload=0;
for(const e of out){histogram[e.commandId]=(histogram[e.commandId]||0)+1;if(Number.isFinite(e.payloadBytes))maxPayload=Math.max(maxPayload,e.payloadBytes)}
return {sessionId:d?.connectionSessionId??null,events:events.length,outCount:out.length,histogram,maxPayload};
`

// ---- fixture input (private) and fresh local source ----
const fixture = JSON.parse(await readFile(inputPath, 'utf8'))
const name = fixture.owned
const total = fixture.totalBytes
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
if (typeof name !== 'string' || !name || name.length > 27 || /[\\/]/.test(name) || [...name].some(c => c.charCodeAt(0) < 32)) throw Error('Fixture report has no valid owned device filename')
if (!Number.isSafeInteger(total) || total < MINIMUM_FIXTURE_BYTES || total > MAX_DOWNLOAD_BYTES) throw Error('Fixture size must cover the 64-KiB boundary read and stay within 3 MiB')
if (!hex(fixture.sha256, 64) || !hex(fixture.catalogSignatureMd5, 32) || fixture.passed !== true) throw Error('Fixture report is incomplete or did not pass')
const sourcePath = resolve(String(fixture.path))
if (!isAbsolute(String(fixture.path)) || !inside(CACHE, sourcePath)) throw Error('Fixture source must be an absolute path inside the runtime cache')
const secrets = [...new Set([name, sourcePath, inputPath, CACHE, sourcePath.replaceAll('\\', '/'), inputPath.replaceAll('\\', '/'), CACHE.replaceAll('\\', '/')])].sort((a, b) => b.length - a.length)
const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('<private>'), String(value))

const startedAt = Date.now()
const deadline = startedAt + OVERALL_DEADLINE_MS
let current = 'start'
let client = null
const result = {
  observedAt: new Date(startedAt).toISOString(),
  boundary: 'actual-running-app/trusted-preload/sole-USB-owner/current-custom/read-only-transfer-contracts',
  script: 'apps/electron/scripts/verify-current-transfer-contracts.mjs',
  expectations: { versionNumber: EXPECTED_VERSION, versionCode: EXPECTED_VERSION_CODE, maxDownloadBytes: MAX_DOWNLOAD_BYTES, maxReadBytes: MAX_READ_BYTES,
    prefixCount: PREFIX_COUNT, boundaryRange: { offset: BOUNDARY_OFFSET, count: BOUNDARY_COUNT }, eofRangeCount: EOF_COUNT,
    pageSize: PAGE_SIZE, maxPageRequests: MAX_PAGE_REQUESTS },
}

async function renderer(label, body, args, timeoutMs) {
  if (FORBIDDEN.test(body)) throw Error(`Renderer step ${label} contains a forbidden operation`)
  if (Date.now() > deadline) throw Error('Overall deadline exceeded')
  current = label
  return client.evaluate(`(async()=>{${PRELUDE}const A=${JSON.stringify(args)};${body}\n})()`, timeoutMs + 20000)
}

async function readState(label, identity = false) {
  const reply = await renderer(label, identity ? IDENTITY_BODY : STATE_BODY, {}, identity ? 200000 : 110000)
  for (let i = 0; i < (identity ? reply.stateReads : 1); i++) tally(...stateCalls)
  return reply
}

async function bounded(prefix, offset, count) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > MAX_READ_BYTES || offset + count > total || (prefix && offset !== 0)) {
    throw Error('Refusing a request that is not locally valid')
  }
  tally(prefix ? 'readFilePrefix' : 'readFileRange')
  const began = Date.now()
  const label = `${prefix ? 'prefix' : 'range'}@${offset}+${count}`
  const reply = await renderer(label, READ_BODY, { name, prefix, offset, count, timeout: 30000 }, 30000)
  if (reply.timedOut) { tally('cancelDownload'); throw Error(`${label} timed out and was cancelled`) }
  const bytes = Buffer.from(reply.b64, 'base64')
  return {
    offset, count, received: reply.length, ms: Date.now() - began,
    exact: reply.length === count && bytes.length === count && bytes.equals(local.subarray(offset, offset + count)),
    payloadKind: reply.kind,
  }
}

let local = null
try {
  // ---- local source, no device contact ----
  current = 'local-source'
  const sourceStat = await stat(sourcePath)
  must('local-size-matches-fixture', sourceStat.size === total)
  local = await readFile(sourcePath)
  const freshSha = sha256(local)
  must('local-fresh-sha256-equals-input', freshSha === fixture.sha256)
  result.fixture = { totalBytes: total, sha256: freshSha, freshLocalSha256MatchesInput: true }

  client = await openValidationClient()

  // ---- identity and idle ----
  const identity = await readState('identity', true)
  const sessionId = identity.sessionId
  must('device-connected', identity.connected)
  must('device-model', identity.model === 'hidock-h1e', `model=${identity.model}`)
  must('device-version', identity.versionNumber === EXPECTED_VERSION && identity.versionCode === EXPECTED_VERSION_CODE, `version=${identity.versionNumber}/${identity.versionCode}`)
  must('native-idle-before', identity.nativeIdle)
  must('live-audio-idle-before', identity.audioIdle, `audio=${identity.audioStatus}`)
  must('connection-session-present', sessionId !== null)
  if (identity.already === false) tally('connect')
  tally('isConnected')
  result.device = { model: identity.model, versionNumber: identity.versionNumber, versionCode: identity.versionCode, connectedBeforeRun: identity.already }

  // ---- current detailed catalog and the owned fixture ----
  tally('listFilesDetailed')
  const catalogReply = await renderer('catalog', CATALOG_BODY, { timeout: 90000 }, 90000)
  const entries = catalogReply.files
  must('catalog-complete', catalogReply.status === 'complete' && Array.isArray(entries), `status=${catalogReply.status} reason=${catalogReply.reason}`)
  must('catalog-counts-agree', catalogReply.parsedCount === entries.length && catalogReply.expectedCount === entries.length,
    `expected=${catalogReply.expectedCount} parsed=${catalogReply.parsedCount} entries=${entries.length}`)
  must('catalog-not-empty', entries.length > 0)
  must('catalog-names-unique', new Set(entries.map(e => e.n)).size === entries.length)
  const owned = entries.filter(e => e.n === name)
  must('fixture-present-exactly-once', owned.length === 1, `matches=${owned.length}`)
  must('fixture-catalog-size-exact', owned[0].l === total, `catalogSize=${owned[0].l} expected=${total}`)
  must('fixture-catalog-signature-exact', owned[0].s === fixture.catalogSignatureMd5)
  result.catalog = {
    status: catalogReply.status, expectedCount: catalogReply.expectedCount, parsedCount: catalogReply.parsedCount, entryCount: entries.length,
    fixtureCount: owned.length, fixtureSizeExact: true, fixtureSignatureExact: true,
  }

  // ---- one transfer-boundary range, one EOF range and one prefix ----
  const ranges = [
    { label: 'cross-64KiB', ...await bounded(false, BOUNDARY_OFFSET, BOUNDARY_COUNT) },
    { label: 'last52-to-EOF', ...await bounded(false, total - EOF_COUNT, EOF_COUNT) },
  ]
  const prefixes = [await bounded(true, 0, PREFIX_COUNT)]
  result.ranges = ranges
  result.prefixes = prefixes
  check('ranges-all-exact', ranges.every(r => r.exact), `${ranges.filter(r => !r.exact).length} range mismatches`)
  check('prefixes-all-exact', prefixes.every(r => r.exact), `${prefixes.filter(r => !r.exact).length} prefix mismatches`)
  check('read-payloads-uint8array', [...ranges, ...prefixes].every(r => r.payloadKind === '[object Uint8Array]'))
  result.readSummary = {
    rangeRequests: ranges.length, rangesExact: ranges.filter(r => r.exact).length,
    prefixRequests: prefixes.length, prefixesExact: prefixes.filter(r => r.exact).length,
    bytesRequested: [...ranges, ...prefixes].reduce((sum, r) => sum + r.count, 0),
  }

  // ---- traverse the entire detailed catalog with at most five contiguous pages ----
  const total_entries = entries.length
  const expectedPageRequests = Math.ceil(total_entries / PAGE_SIZE)
  must('catalog-fits-page-request-bound', expectedPageRequests > 0 && expectedPageRequests <= MAX_PAGE_REQUESTS,
    `entries=${total_entries} requests=${expectedPageRequests}`)
  const paging = [], traversedEntries = []
  for (let first = 0; first < total_entries; first += PAGE_SIZE) {
    const count = Math.min(PAGE_SIZE, total_entries - first)
    tally('listFilesPage')
    const pageStarted = Date.now()
    const reply = await renderer(`page@${first}+${count}`, PAGE_BODY, { first, count, timeout: 20000 }, 20000)
    const files = Array.isArray(reply.files) ? reply.files : []
    const shapeOk = reply.status === 'complete' && files.length === count && reply.firstIndex === first && reply.requestedCount === count
    const orderMatches = shapeOk && files.every((file, i) => ENTRY_FIELDS.every(key => file[key] === entries[first + i][key]))
    const totalCountMatchesCatalog = reply.totalCount === total_entries
    traversedEntries.push(...files)
    paging.push({ firstIndex: first, count, status: reply.status, reason: reply.reason, returned: files.length,
      totalCount: reply.totalCount, totalCountMatchesCatalog, orderMatches, ms: Date.now() - pageStarted })
  }
  const fixtureMatches = traversedEntries.filter(file => file.n === name && file.l === total).length
  result.paging = paging
  result.pageSummary = { requests: paging.length, expectedRequests: expectedPageRequests, requestedEntries: paging.reduce((sum, page) => sum + page.count, 0),
    returnedEntries: traversedEntries.length, catalogEntriesCovered: traversedEntries.length === total_entries, fixtureMatches }
  check('paging-covers-entire-catalog', paging.length === expectedPageRequests && traversedEntries.length === total_entries
    && paging.reduce((sum, page) => sum + page.returned, 0) === total_entries)
  check('paging-ordered-match-detailed', paging.every(page => page.orderMatches))
  check('paging-total-count-consistent', paging.every(page => page.totalCountMatchesCatalog))
  check('paging-contains-owned-fixture-exactly-once', fixtureMatches === 1)

  // ---- idle and session continuity before the whole-file download ----
  const beforeDownload = await readState('state-before-download')
  must('session-unchanged-before-download', beforeDownload.sessionId === sessionId && beforeDownload.connected)
  must('native-idle-before-download', beforeDownload.nativeIdle)
  must('live-audio-idle-before-download', beforeDownload.audioIdle, `audio=${beforeDownload.audioStatus}`)

  // ---- whole-file CMD5 download of the owned fixture through the existing event handlers ----
  tally('onDownloadChunk', 'onDownloadProgress', 'downloadFile')
  const downloadStarted = Date.now()
  const download = await renderer('whole-file-download', DOWNLOAD_BODY, { name, size: total, cap: MAX_DOWNLOAD_BYTES, timeout: 240000, settleMs: 500 }, 240000 + 500)
  const downloadMs = Date.now() - downloadStarted
  for (let i = 0; i < download.cancels; i++) tally('cancelDownload')
  const received = download.b64 === null ? null : Buffer.from(download.b64, 'base64')
  const exact = received !== null && received.length === total && received.equals(local)
  const receivedSha = received === null ? null : sha256(received)
  check('download-returned-true', download.returned === true && download.failure === null, `returned=${download.returned} failure=${download.failure}`)
  check('download-within-bound', !download.overflow && download.chunkTotal <= MAX_DOWNLOAD_BYTES)
  check('download-exact-bytes', exact)
  check('download-sha256-equals-input', receivedSha === fixture.sha256)
  check('download-chunk-total-equals-size', download.chunkTotal === total && download.retained === total, `chunkTotal=${download.chunkTotal}`)
  check('download-unsubscribed', download.stopsCalled === 2)
  check('chunk-event-signature', download.proof.chunkKeys.length === 1 && download.proof.chunkKeys[0] === 'data,filename'
    && download.proof.chunkKinds.length === 1 && download.proof.chunkKinds[0] === '[object Uint8Array]'
    && download.proof.foreignChunks === 0 && download.proof.badChunks === 0,
    `keys=${download.proof.chunkKeys.join('|')} kinds=${download.proof.chunkKinds.join('|')}`)
  check('progress-event-signature', download.proof.progressKeys.length === 1 && download.proof.progressKeys[0] === 'bytesReceived,filename,totalBytes'
    && download.proof.progressTypes.length === 1 && download.proof.progressTypes[0] === 'number,number' && download.proof.foreignProgress === 0,
    `keys=${download.proof.progressKeys.join('|')} types=${download.proof.progressTypes.join('|')}`)
  check('progress-observed', download.progress.events > 0)
  check('progress-monotonic-within-total', download.progress.monotonic && download.progress.withinTotal && download.progress.maxReceived <= total)
  result.download = {
    fileBytes: total, sha256: receivedSha, exactBytes: exact, returned: download.returned, failure: download.failure === null ? null : scrub(download.failure),
    ms: downloadMs, chunkEvents: download.chunkEvents, chunkBytes: download.chunkTotal, chunkMinBytes: download.chunkMin, chunkMaxBytes: download.chunkMax,
    eventSignature: {
      chunkKeys: download.proof.chunkKeys, chunkPayloadKinds: download.proof.chunkKinds,
      progressKeys: download.proof.progressKeys, progressValueTypes: download.proof.progressTypes,
      foreignChunks: download.proof.foreignChunks, badChunks: download.proof.badChunks, foreignProgress: download.proof.foreignProgress,
    },
    progress: { ...download.progress, finalEqualsTotal: download.progress.final === total },
    unsubscribed: download.stopsCalled === 2,
  }

  // ---- final idle, session continuity and outgoing command summary ----
  const after = await readState('state-after')
  check('session-unchanged-after', after.sessionId === sessionId && after.connected)
  check('device-version-after', after.versionNumber === EXPECTED_VERSION)
  check('native-idle-after', after.nativeIdle)
  check('live-audio-idle-after', after.audioIdle, `audio=${after.audioStatus}`)
  tally('getProtocolDiagnostics')
  const protocol = await renderer('protocol-summary', PROTOCOL_BODY, { since: startedAt }, 30000)
  check('protocol-session-continuous', protocol.sessionId === sessionId)
  result.protocol = { sameConnectionSession: protocol.sessionId === sessionId, diagnosticEvents: protocol.events, outgoingFrames: protocol.outCount, outgoingByCommandId: protocol.histogram, maxOutgoingPayloadBytes: protocol.maxPayload }
  result.idle = { nativeBefore: identity.nativeIdle, liveBefore: identity.audioIdle, nativeAfter: after.nativeIdle, liveAfter: after.audioIdle }
} catch (error) {
  failures.push(`${current}: ${scrub(error && error.message ? error.message : error)}`)
  result.abortedAt = current
} finally {
  if (client) client.close()
  const totalCalls = Object.values(calls).reduce((sum, value) => sum + value, 0)
  result.operations = {
    ipcCallsByMethod: calls, ipcCalls: totalCalls,
    deletes: 0, settingsMutations: 0, recordingControls: 0, libraryPublications: 0, providerRequests: 0, firmwareWrites: 0, storageWrites: 0,
    allowedMethodCount: ALLOWED_METHODS.size,
  }
  result.checks = checks
  result.failures = failures.map(scrub)
  result.passed = failures.length === 0 && Object.keys(checks).length > 0
  result.elapsedMs = Date.now() - startedAt
}

const text = scrub(JSON.stringify(result, null, 2)) + '\n'
if (text.includes(name) || text.includes(sourcePath)) throw Error('Refusing to publish a result that still contains private identity')
const evidencePath = join(RUNTIME, `current-transfer-contracts-${startedAt}.json`)
await writeFile(evidencePath, text, { flag: 'wx' })
console.log(JSON.stringify({
  passed: result.passed, evidencePath, checks: Object.keys(checks).length, failures: result.failures,
  catalogEntries: result.catalog?.entryCount ?? null, rangeRequests: result.readSummary?.rangeRequests ?? null, pageRequests: result.paging?.length ?? null,
  downloadExact: result.download?.exactBytes ?? null, ipcCalls: result.operations.ipcCalls,
}, null, 2))
if (!result.passed) process.exitCode = 1
