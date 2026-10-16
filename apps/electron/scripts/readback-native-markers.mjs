/** Read actual hardware-produced bytes with the application parser and an independent decoder. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const root = resolve('node_modules', '.cache', 'device-hardware-verification')
const evidencePath = resolve(root, 'native-marker-verification.private.json')
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
const source = evidence.download.path
const before = await readFile(source)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(hash(before), evidence.download.sha256)
const reader = resolve(root, 'native-marker-reader.cjs')
await build({ entryPoints: ['electron/main/services/device-recording-markers.ts'], outfile: reader, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const trailer = await require(reader).readNativeMarkerTrailer(source)
assert.equal(trailer.present, true)
assert.equal(trailer.timestampsMs.length, 1)
assert.ok(trailer.timestampsMs[0] >= evidence.observation.beforeMarker.duration * 1000)
assert.ok(trailer.timestampsMs[0] < (evidence.observation.beforeMarker.duration + 3) * 1000)
assert.ok(trailer.timestampsMs[0] < evidence.observation.afterMarker.duration * 1000)
const geometry = spawnSync('python', [resolve('../../research/rea/firmware_lab.py'), 'inspect-mp3', source], { encoding: 'utf8', windowsHide: true })
assert.equal(geometry.status, 0, geometry.stderr)
const frames = JSON.parse(geometry.stdout)
assert.deepEqual(frames.markers_ms, trailer.timestampsMs)
const decoder = require('ffmpeg-static')
const wav = resolve(root, 'native-marker-stock-6.3.0-decoded.private.wav')
const decoded = spawnSync(decoder, ['-v', 'error', '-n', '-i', source, '-c:a', 'pcm_s16le', wav], { encoding: 'utf8', windowsHide: true })
await writeFile(resolve(root, 'native-marker-decode.private.log'), decoded.stderr)
assert.equal(decoded.status, 0, 'Independent MP3 decoder failed')
const pcm = await readFile(wav)
assert.equal(pcm.toString('ascii', 0, 4), 'RIFF')
assert.equal(pcm.toString('ascii', 8, 12), 'WAVE')
let offset = 12, format, dataBytes
while (offset + 8 <= pcm.length) {
  const id = pcm.toString('ascii', offset, offset + 4), length = pcm.readUInt32LE(offset + 4), start = offset + 8
  assert.ok(start + length <= pcm.length)
  if (id === 'fmt ') format = { encoding: pcm.readUInt16LE(start), channels: pcm.readUInt16LE(start + 2), rate: pcm.readUInt32LE(start + 4), bits: pcm.readUInt16LE(start + 14) }
  if (id === 'data') dataBytes = length
  offset = start + length + (length & 1)
}
assert.deepEqual(format, { encoding: 1, channels: 1, rate: 16000, bits: 16 })
assert.ok(dataBytes > 0)
assert.equal(hash(await readFile(source)), hash(before))
evidence.readback = { trailer, frames, decoded: { ...format, frames: dataBytes / 2, seconds: dataBytes / 32000, sha256: hash(pcm) }, sourceUnchanged: true }
await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ markerCount: trailer.timestampsMs.length, timestampsMs: trailer.timestampsMs, nativeFrames: frames.frames, decoded: evidence.readback.decoded, sourceUnchanged: true }, null, 2))
