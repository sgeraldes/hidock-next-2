import { openValidationClient } from './device-validation-client.mjs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import Database from 'better-sqlite3'
const directory = resolve('node_modules/.cache/completion630-runtime')
const profile = JSON.parse(await readFile(join(directory, 'isolated-profile.private.json'), 'utf8'))
if (!resolve(profile.dataPath).startsWith(directory + '\\')) throw Error('Only the isolated library is permitted')
const recordingId = randomUUID(), sessionId = randomUUID(), requestId = randomUUID()
const filePath = join(profile.dataPath, 'recordings', `owned-marker-fixture-${recordingId}.wav`)
// One second of distinguishable synthetic stereo PCM. This is not a physical source calibration.
const pcm = Buffer.alloc(64000)
for (let i = 0; i < 16000; i++) { pcm.writeInt16LE(Math.round(1000 * Math.sin(i * Math.PI / 16)), i * 4); pcm.writeInt16LE(Math.round(2000 * Math.cos(i * Math.PI / 32)), i * 4 + 2) }
const header = Buffer.alloc(44)
header.write('RIFF'); header.writeUInt32LE(64036, 4); header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22)
header.writeUInt32LE(16000, 24); header.writeUInt32LE(64000, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(64000, 40)
const trailer = Buffer.alloc(16); trailer.write('HiDockVM'); trailer.writeUInt32LE(1, 8); trailer.writeUInt32LE(500, 12)
const original = Buffer.concat([header, pcm, trailer]), originalHash = createHash('sha256').update(original).digest('hex')
await writeFile(filePath, original)
await writeFile(filePath.replace(/\.wav$/, '.live.json'), JSON.stringify({ captureSessionId: sessionId, seconds: 999999, sampleElapsedMs: 99999999 }))
const markerDirectory = join(profile.profile, 'device-recording-markers')
await mkdir(markerDirectory, { recursive: true })
const sessionKey = createHash('sha256').update(`session\0${sessionId}`).digest('hex')
const savedMarker = { id: randomUUID(), requestId: randomUUID(), atMs: 750, source: 'manual', persistence: 'local-sidecar', createdAt: new Date().toISOString(), label: 'Owned persisted session fixture' }
await writeFile(join(markerDirectory, `${sessionKey}.json`), JSON.stringify({ version: 1, subject: { kind: 'session', id: sessionId }, automationEnabled: false, markers: [savedMarker] }))
const db = new Database(join(profile.dataPath, 'data', 'hidock.db'), { fileMustExist: true })
try { db.prepare("INSERT INTO recordings(id,filename,file_path,file_size,duration_seconds,date_recorded,location,on_local,on_device,source,is_imported,transcription_status) VALUES(?,?,?,?,NULL,?,'local',1,0,'pc',1,'none')").run(recordingId, `owned-marker-fixture-${recordingId}.wav`, filePath, original.length, new Date().toISOString()) } finally { db.close() }
const client = await openValidationClient()
const evidence = { observedAt: new Date().toISOString(), boundary: 'built-app-IPC/persisted-owned-WAV/isolated-SQLite-and-marker-sidecars', fixtureSeeded: true, actualHardwareCapture: false, originalLibraryMutated: false, deviceWritesRequested: 0, actualAudioDurationMs: 1000, databaseDurationUnknown: true, manifestTimingDeliberatelyIncorrect: true }
try {
  const result = await client.evaluate(`(async()=>{const a=window.electronAPI,m=a.deviceRecordingMarkers,s={kind:'recording',id:${JSON.stringify(recordingId)}},first=await m.list(s),second=await m.list(s),native=await m.importNative(s),request={subject:s,requestId:${JSON.stringify(requestId)},atMs:250,source:'audio-event'};const disabled=await m.add(request);await m.setAutomation(s,true);const enabled=await m.add(request),again=await m.add(request),past=await m.add({subject:s,requestId:crypto.randomUUID(),atMs:1500});const tracks=await a.deviceAudio.exportTracks(s.id);return {firstCount:first.length,repeatCount:second.length,sessionAtMs:first[0]?.atMs,nativeStatus:native.status,nativeCount:native.markers.length,nativeAtMs:native.markers[0]?.atMs,disabledStatus:disabled.status,enabledStatus:enabled.status,idempotent:again.marker?.id===enabled.marker?.id,pastStatus:past.status,tracks}})()`)
  evidence.markers = { ...result, tracks: undefined }
  const output = result.tracks
  evidence.trackExportKeys = Object.keys(output)
  evidence.trackExport = { sampleRate: output.sampleRate, frames: output.frames, seconds: output.seconds, physicalSourceMapping: output.physicalSourceMapping, channels: [] }
  for (const track of output.tracks) {
    if (!resolve(track.path).startsWith(resolve(join(profile.profile, 'device-audio-exports')) + '\\')) throw Error('Export escaped the isolated profile')
    const mono = await readFile(track.path)
    let equal = mono.length === 32044 && mono.readUInt16LE(22) === 1 && mono.readUInt32LE(24) === 16000
    for (let i = 0; equal && i < 16000; i++) equal = mono.readInt16LE(44 + i * 2) === pcm.readInt16LE(i * 4 + track.channelIndex * 2)
    evidence.trackExport.channels.push({ channelIndex: track.channelIndex, bytes: mono.length, samplesEqualSourceChannel: equal })
  }
  evidence.originalBytesUnchanged = createHash('sha256').update(await readFile(filePath)).digest('hex') === originalHash
  evidence.originalSha256 = originalHash
  evidence.passed = result.firstCount === 1 && result.repeatCount === 1 && result.sessionAtMs === 750 && result.nativeStatus === 'imported' && result.nativeAtMs === 500 && result.nativeCount === 1 && result.disabledStatus === 'automation-disabled' && result.enabledStatus === 'accepted-local' && result.idempotent && result.pastStatus === 'invalid' && evidence.originalBytesUnchanged && evidence.trackExport.channels.length === 2 && evidence.trackExport.channels.every(value => value.samplesEqualSourceChannel)
} catch { evidence.failure = 'Saved capture marker IPC qualification failed'; process.exitCode = 1 }
finally { await writeFile('../../research/rea/completion630-lab/runtime/saved-capture-markers.json', JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2)); client.close() }
if (!evidence.passed) process.exitCode = 1
