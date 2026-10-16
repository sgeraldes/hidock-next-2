/** Real host service/file boundary against qualified synthetic native WAV output.
 * No application/device/provider commands; originals preserved, owned temp only.
 * Run with Node26 from any cwd. TypeScript transpilation handles the actual
 * marker service's parameter properties; no service behavior is replaced.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const lab = join(root, 'research/rea/evidence/h1e-6.3.0-lossless')
const services = join(root, 'apps/electron/electron/main/services')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const preserved = new Map()
const loaders = {}
const actualModuleUrls = new Map()
async function service(name) {
  const path = join(services, `${name}.ts`)
  const source = await readFile(path)
  preserved.set(path, source)
  try {
    const loaded = await import(pathToFileURL(path).href)
    actualModuleUrls.set(path, pathToFileURL(path).href)
    loaders[name] = 'Node26 native TypeScript strip-only import'
    return loaded
  } catch (error) {
    const actualRelativeServiceImport = error.code === 'ERR_MODULE_NOT_FOUND' &&
      typeof error.url === 'string' && error.url.startsWith(pathToFileURL(services + sep).href)
    if (error.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' && !actualRelativeServiceImport) throw error
    const ts = (await import(pathToFileURL(join(root, 'apps/electron/node_modules/typescript/lib/typescript.js')).href)).default
    const result = ts.transpileModule(source.toString('utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, isolatedModules: true,
    } })
    let output = result.outputText.replace(/from (["'])(\.[^"']+)\1/g, (_all, quote, relative) => {
      const dependency = resolve(dirname(path), relative.endsWith('.ts') ? relative : `${relative}.ts`)
      assert(dependency.startsWith(services + sep), 'Unexpected runtime service dependency')
      return `from ${quote}${actualModuleUrls.get(dependency) ?? pathToFileURL(dependency).href}${quote}`
    })
    loaders[name] = `Unmodified actual source transpiled with TypeScript${ts.version}; actual relative TS service imports resolved to already loaded unmodified source module URLs or file URLs`
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
    actualModuleUrls.set(path, moduleUrl)
    return import(moduleUrl)
  }
}
const { readAudioDuration } = await service('audio-duration')
const { inspectDeviceAudioWav, exportDeviceAudioTracks } = await service('device-audio-track-export')
const { readNativeMarkerTrailer, parseNativeMarkerTail } = await service('device-recording-markers')
const qualified = JSON.parse(await readFile(join(lab, 'lossless-verification.json'), 'utf8'))
assert.equal(qualified.status, 'passed')
const results = {}, gaps = []
const temporary = await mkdtemp(join(tmpdir(), 'rea-native-format-host-'))
const verifiedTemp = await realpath(temporary)
const tempParent = await realpath(tmpdir())
assert(verifiedTemp.startsWith(tempParent + sep) && verifiedTemp !== tempParent)
const owner = join(verifiedTemp, 'OWNER')
await writeFile(owner, 'rea-native-format-host-interop-owned-temp', { flag: 'wx' })

async function markerObservation(path) {
  try { return { accepted: true, result: await readNativeMarkerTrailer(path) } }
  catch (error) { return { accepted: false, error: error.message } }
}
function footer(times) {
  const bytes = Buffer.alloc(12 + times.length * 4)
  bytes.write('HiDockVM', 0, 'ascii'); bytes.writeUInt32LE(times.length, 8)
  times.forEach((value, index) => bytes.writeUInt32LE(value, 12 + index * 4))
  return bytes
}
async function sampleExactExport(path, originalBytes, label, expectedFrames) {
  const directory = join(verifiedTemp, `tracks-${label}`)
  await mkdir(directory)
  const out = await exportDeviceAudioTracks(path, directory)
  assert.equal(out.sampleRate, 16000); assert.equal(out.frames, expectedFrames)
  assert.equal(out.physicalSourceMapping, 'unverified'); assert.equal(out.tracks.length, 2)
  const pcm = originalBytes.subarray(44, 44 + expectedFrames * 4)
  const tracks = []
  for (let channel = 0; channel < 2; channel++) {
    const track = out.tracks[channel]
    assert.equal(track.channelId, `channel-${channel}`); assert.equal(track.channelIndex, channel)
    const raw = await readFile(track.path), layout = await inspectDeviceAudioWav(track.path)
    assert.equal(layout.channels, 1); assert.equal(layout.frames, expectedFrames)
    const expected = Buffer.alloc(expectedFrames * 2)
    for (let frame = 0; frame < expectedFrames; frame++) pcm.copy(expected, frame * 2, frame * 4 + channel * 2, frame * 4 + channel * 2 + 2)
    assert.deepEqual(raw.subarray(44), expected)
    tracks.push({ channelId: track.channelId, bytes: raw.length, pcmSha256: hash(expected) })
  }
  const existing = await Promise.all(out.tracks.map(async (track) => [track.path, await readFile(track.path)]))
  await assert.rejects(() => exportDeviceAudioTracks(path, directory), /EEXIST/)
  for (const [path, bytes] of existing) assert.deepEqual(await readFile(path), bytes)
  assert.equal((await readdir(directory)).length, 2)
  return { tracks, exclusiveCreationRefusedWithoutOverwrite: true }
}
try {
  for (const [name, expected] of Object.entries(qualified.files)) {
    const path = join(lab, name), bytes = await readFile(path)
    assert.equal(hash(bytes), expected.wav_sha256)
    preserved.set(path, bytes)
    const layout = await inspectDeviceAudioWav(path), duration = readAudioDuration(path)
    assert.deepEqual(layout, { sampleRate: 16000, channels: 2, frames: expected.frames_per_lane,
      seconds: expected.duration_seconds, durationMs: Math.floor(expected.duration_seconds * 1000) })
    if (!duration || Math.abs(duration.seconds - expected.duration_seconds) > 1e-12) {
      gaps.push({ case: name, service: 'readAudioDuration', expectedSeconds: expected.duration_seconds, observed: duration })
    }
    const markers = await markerObservation(path)
    const tracks = await sampleExactExport(path, bytes, name.replace(/\W/g, '_'), expected.frames_per_lane)
    results[name] = { layout, duration, markers, ...tracks, originalSha256: hash(bytes),
      nativeFooterInterpretation: name.includes('trailing') ? 'Prototype synthetic metadata has no HiDockVM signature; marker validity is not asserted' : 'No marker footer supplied' }
  }
  const canonicalEmpty = await readFile(join(lab, 'empty.wav'))
  const emptyZero = Buffer.concat([canonicalEmpty, footer([])])
  const emptyPath = join(verifiedTemp, 'empty-native-wav-zero-markers.wav')
  await writeFile(emptyPath, emptyZero, { flag: 'wx' })
  const emptyDuration = readAudioDuration(emptyPath), emptyLayout = await inspectDeviceAudioWav(emptyPath)
  const emptyMarkers = await markerObservation(emptyPath)
  if (!emptyDuration || emptyDuration.seconds !== 0) gaps.push({ case: 'canonical_empty_wav_with_zero_count_HiDockVM', service: 'readAudioDuration', expectedSeconds: 0, observed: emptyDuration })
  if (!emptyMarkers.accepted) gaps.push({ case: 'canonical_empty_wav_with_zero_count_HiDockVM', service: 'readNativeMarkerTrailer', expected: 'recognized zero-count trailer after validated RIFF boundary', observed: emptyMarkers })
  assert.equal(emptyLayout.frames, 0); assert.equal(emptyLayout.seconds, 0)
  const parsedEmpty = parseNativeMarkerTail(emptyZero.subarray(Math.max(0, emptyZero.length - 412)), emptyZero.length)
  assert.deepEqual(parsedEmpty.timestampsMs, []); assert.equal(parsedEmpty.present, true); assert.equal(parsedEmpty.audioPrefixBytes, 44)
  results.canonicalEmptyZeroMarkers = { layout: emptyLayout, duration: emptyDuration, markers: emptyMarkers, tailParser: parsedEmpty,
    ...(await sampleExactExport(emptyPath, emptyZero, 'canonical-empty-zero-markers', 0)) }
  const source = await readFile(join(lab, 'three-native-blocks.wav'))
  const validMarked = Buffer.concat([source, footer([36, 72])])
  const markedPath = join(verifiedTemp, 'native-wav-valid-markers.wav')
  await writeFile(markedPath, validMarked, { flag: 'wx' })
  const parsed = parseNativeMarkerTail(validMarked.subarray(-412), validMarked.length)
  assert.deepEqual(parsed.timestampsMs, [36, 72]); assert.equal(parsed.audioPrefixBytes, source.length)
  const observed = await markerObservation(markedPath)
  if (!observed.accepted) gaps.push({ case: 'paired_wav_with_valid_HiDockVM', service: 'readNativeMarkerTrailer', expected: 'timestamps36/72ms after validated RIFF end', observed })
  results.validMarkedWav = { layout: await inspectDeviceAudioWav(markedPath), duration: readAudioDuration(markedPath), markers: observed, tailParser: parsed }
  const invalids = [
    ['truncated_pcm', source.subarray(0, source.length - 1), /Invalid WAV container size/],
    ['bad_align', (() => { const b = Buffer.from(source); b.writeUInt16LE(2, 32); return b })(), /Invalid WAV sample format/],
    ['declared_data_overflow', (() => { const b = Buffer.from(source); b.writeUInt32LE(6916, 40); return b })(), /WAV chunk exceeds container bounds/],
  ]
  results.invalidWav = []
  for (const [name, bytes, error] of invalids) {
    const path = join(verifiedTemp, `${name}.wav`)
    await writeFile(path, bytes, { flag: 'wx' })
    await assert.rejects(() => inspectDeviceAudioWav(path), error)
    results.invalidWav.push({ case: name, layoutRejected: true, durationObservation: readAudioDuration(path) })
  }
  results.markerWavRejections = []
  const inside = Buffer.from(source); footer([]).copy(inside, inside.length - 12)
  const nonPcm = Buffer.from(source); nonPcm.writeUInt16LE(3, 20)
  const badRiff = Buffer.from(source); badRiff.writeUInt32LE(source.length, 4)
  for (const [label, bytes, expected] of [
    ['valid_HiDockVM_inside_PCM', inside, /must follow the complete RIFF payload/],
    ['nonPCM16_format', nonPcm, /Only uncompressed PCM16/],
    ['RIFF_bounds_overflow', badRiff, /Invalid WAV container size/],
  ]) {
    const path = join(verifiedTemp, `${label}.wav`)
    await writeFile(path, bytes, { flag: 'wx' })
    await assert.rejects(() => readNativeMarkerTrailer(path), expected)
    results.markerWavRejections.push({ case: label, rejected: true })
  }
  const mp3Path = join(root, 'research/rea/evidence/h1e-6.3.0-stereo-integration/codec/quality-control/profile-2/actual-quality-profile.mp3')
  const mp3Bytes = await readFile(mp3Path)
  const mp3Qualification = JSON.parse(await readFile(join(dirname(mp3Path), 'decode-verification.json'), 'utf8'))
  assert.equal(hash(mp3Bytes), mp3Qualification.source_sha256)
  assert.equal(mp3Qualification.decoder_exit, 0)
  preserved.set(mp3Path, mp3Bytes)
  const ownMarkedMp3 = join(verifiedTemp, 'qualified-synthetic-marked.hda')
  await writeFile(ownMarkedMp3, Buffer.concat([mp3Bytes, footer([36, 72])]), { flag: 'wx' })
  const nativeMp3Markers = await readNativeMarkerTrailer(ownMarkedMp3)
  assert.equal(nativeMp3Markers.present, true); assert.equal(nativeMp3Markers.audioPrefixBytes, mp3Bytes.length)
  assert.deepEqual(nativeMp3Markers.timestampsMs, [36, 72])
  results.existingSyntheticMp3WithMarkers = { accepted: true, sourceSha256: hash(mp3Bytes), markers: nativeMp3Markers,
    durationObservation: readAudioDuration(ownMarkedMp3), originalDurationObservation: readAudioDuration(mp3Path) }
  // Historical captures declare PCM16 while carrying MPEG frames. This is an
  // actual legacy-file boundary, distinct from qualified native PCM output.
  assert.equal(mp3Bytes.length % 4, 0)
  const legacyHeader = Buffer.from(canonicalEmpty)
  legacyHeader.writeUInt32LE(36 + mp3Bytes.length, 4)
  legacyHeader.writeUInt32LE(mp3Bytes.length, 40)
  const legacyBytes = Buffer.concat([legacyHeader, mp3Bytes])
  const legacyPath = join(verifiedTemp, 'legacy-PCM-declaration-MPEG-payload.wav')
  await writeFile(legacyPath, legacyBytes, { flag: 'wx' })
  const legacyDuration = readAudioDuration(legacyPath)
  assert(legacyDuration && legacyDuration.how.startsWith('mpeg '))
  assert.equal(legacyDuration.seconds, readAudioDuration(mp3Path).seconds)
  let legacyLayout, legacyExport
  try { legacyLayout = { accepted: true, result: await inspectDeviceAudioWav(legacyPath) } }
  catch (error) { legacyLayout = { accepted: false, error: error.message } }
  const legacyDirectory = join(verifiedTemp, 'legacy-mpeg-track-exports')
  await mkdir(legacyDirectory)
  try {
    const value = await exportDeviceAudioTracks(legacyPath, legacyDirectory)
    legacyExport = { accepted: true, frames: value.frames, tracks: value.tracks.length,
      outputPcmSha256: await Promise.all(value.tracks.map(async (t) => hash((await readFile(t.path)).subarray(44)))) }
  } catch (error) { legacyExport = { accepted: false, error: error.message } }
  if (!legacyExport.accepted) assert.deepEqual(await readdir(legacyDirectory), [])
  const legacyMarkedPath = join(verifiedTemp, 'legacy-mpeg-wav-marked.wav')
  await writeFile(legacyMarkedPath, Buffer.concat([legacyBytes, footer([36, 72])]), { flag: 'wx' })
  const legacyMarkers = await markerObservation(legacyMarkedPath)
  for (const [serviceName, observed] of [['inspectDeviceAudioWav', legacyLayout], ['exportDeviceAudioTracks', legacyExport], ['readNativeMarkerTrailer', legacyMarkers]]) {
    if (observed.accepted) gaps.push({ case: 'legacy_RIFF_PCM16_declaration_actual_MPEG_payload', service: serviceName,
      expected: 'Compressed payload must be rejected by PCM-only consumers', observed })
  }
  assert.deepEqual(await readFile(legacyPath), legacyBytes)
  results.legacyMpegWav = { sourceMpegSha256: hash(mp3Bytes), syntheticWrapperSha256: hash(legacyBytes),
    declaredChannels: 2, declaredSampleRate: 16000, declaredPcmFrames: mp3Bytes.length / 4,
    duration: legacyDuration, layout: legacyLayout, export: legacyExport, markers: legacyMarkers,
    sourcePreserved: true, rejectedExportCreatedNoFiles: !legacyExport.accepted }
  const malformed = footer([]); malformed.writeUInt32LE(101, 8)
  assert.throws(() => parseNativeMarkerTail(malformed, malformed.length), /Malformed or ambiguous/)
  assert.throws(() => parseNativeMarkerTail(Buffer.from('HiDockVM'), 8), /Truncated/)
  results.markerBounds = { count101Rejected: true, truncatedSignatureRejected: true }
  for (const [path, bytes] of preserved) assert.deepEqual(await readFile(path), bytes)
  const report = { status: gaps.length ? 'actual_host_file_boundary_observed_with_gaps' : 'actual_host_file_boundary_passed',
    nodeVersion: process.version, loaders, serviceSourceSha256: Object.fromEntries([...preserved].filter(([path]) => path.endsWith('.ts')).map(([path, bytes]) => [path.slice(root.length + 1).replaceAll('\\', '/'), hash(bytes)])),
    qualifiedNativeFixtureVerificationSha256: hash(await readFile(join(lab, 'lossless-verification.json'))), results, gaps,
    preservedServiceAndFixtureFiles: preserved.size, actualHostServicesExecuted: true, electronRunningAppVerified: false,
    hardwareVerified: false, providerRequests: 0, privateAudioRead: false,
    boundary: 'Actual unmodified host duration/layout/export/marker services executed against real qualified synthetic files and exclusive temporary tracks. No Electron runtime, customer files, devices or providers.' }
  await writeFile(join(lab, 'host-interop-verification.json'), JSON.stringify(report, null, 2) + '\n')
  if (gaps.length) process.exitCode = 1
  console.log(JSON.stringify({ status: report.status, nativeWavFixtures: Object.keys(qualified.files).length,
    gapCount: gaps.length, gaps, originalFilesPreserved: preserved.size }, null, 2))
} finally {
  const resolved = await realpath(temporary)
  assert.equal(resolved, verifiedTemp)
  assert(resolved.startsWith(tempParent + sep) && resolved !== tempParent)
  assert.equal(await readFile(owner, 'utf8'), 'rea-native-format-host-interop-owned-temp')
  await rm(resolved, { recursive: true })
}
