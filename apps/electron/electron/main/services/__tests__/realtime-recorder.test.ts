/**
 * The realtime stream is saved as a WAV the Library can import (28-sep-2026).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RealtimeRecorder, liveRecordingName, recoverPartialLiveRecordings, wavHeader, type RecorderDeps } from '../realtime-recorder'

const AT = new Date(2026, 8, 28, 10, 45, 12)

/** A device packet: 8-byte header, then the given 16-bit samples. */
function packet(samples: number[], muted = false) {
  const data = Buffer.alloc(8 + samples.length * 2)
  samples.forEach((s, i) => data.writeInt16LE(s, 8 + i * 2))
  return { rest: 0, muted, data: new Uint8Array(data) }
}

function samplesOf(file: string): number[] {
  const b = readFileSync(file)
  const out: number[] = []
  for (let i = 44; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i))
  return out
}

let folder = ''
let deps: RecorderDeps
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'live-rec-'))
  deps = { recordingsPath: () => folder, enabled: () => true, folderMoving: () => false, now: () => AT }
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

describe('realtime recorder', () => {
  it('names the file like the device, so the date parses', () => {
    expect(liveRecordingName(AT)).toBe('2026Sep28-104512-Live.wav')
  })

  it('writes the stereo stream as a .partial, then a WAV with the right header', () => {
    const rec = new RealtimeRecorder(deps)
    expect(rec.start()).toBeNull()
    rec.write(packet([1, -1, 2, -2]))
    expect(readdirSync(folder)).toEqual(['2026Sep28-104512-Live.wav.partial'])
    rec.write(packet([3, -3]))
    const result = rec.finish()
    expect(result).toMatchObject({ status: 'saved', filename: '2026Sep28-104512-Live.wav' })
    const file = join(folder, '2026Sep28-104512-Live.wav')
    const bytes = readFileSync(file)
    expect(bytes.subarray(0, 44).equals(wavHeader(12))).toBe(true)
    expect(bytes.readUInt16LE(22)).toBe(2)
    expect(bytes.readUInt32LE(24)).toBe(16000)
    expect(samplesOf(file)).toEqual([1, -1, 2, -2, 3, -3])
    expect(existsSync(`${file}.partial`)).toBe(false)
  })

  it('a muted stretch is silence of the same length, so time stays right', () => {
    const rec = new RealtimeRecorder(deps)
    rec.start()
    rec.write(packet([5, 5, 5, 5], true))
    rec.finish()
    expect(samplesOf(join(folder, '2026Sep28-104512-Live.wav'))).toEqual([0, 0, 0, 0])
  })

  it('mono firmware is written to both channels; a lone odd packet is a glitch', () => {
    const rec = new RealtimeRecorder(deps)
    rec.start()
    rec.write(packet([7, 7, 9])) // one odd packet: truncated read
    rec.write(packet([1, 2])) // stereo again: the glitch keeps its whole frames
    for (let i = 0; i < 5; i++) rec.write(packet([i, i, i])) // five in a row: mono
    rec.finish()
    const s = samplesOf(join(folder, '2026Sep28-104512-Live.wav'))
    expect(s.slice(0, 4)).toEqual([7, 7, 1, 2])
    expect(s.slice(4, 10)).toEqual([0, 0, 0, 0, 0, 0])
    expect(s.length).toBe(4 + 5 * 6)
  })

  it('one stereo-length packet inside a mono run stays mono', () => {
    const rec = new RealtimeRecorder(deps)
    rec.start()
    for (let i = 0; i < 5; i++) rec.write(packet([1, 1, 1]))
    rec.write(packet([2, 3])) // even number of mono samples: still mono
    rec.finish()
    const s = samplesOf(join(folder, '2026Sep28-104512-Live.wav'))
    expect(s.slice(-4)).toEqual([2, 2, 3, 3])
  })

  it('an empty stream leaves no file', () => {
    const rec = new RealtimeRecorder(deps)
    rec.start()
    expect(rec.finish()).toEqual({ status: 'empty' })
    expect(readdirSync(folder)).toEqual([])
  })

  it('does nothing when the switch is off, and refuses while the folder moves', () => {
    expect(new RealtimeRecorder({ ...deps, enabled: () => false }).start()).toBe('off')
    expect(new RealtimeRecorder({ ...deps, folderMoving: () => true }).start()).toMatch(/being moved/)
    expect(readdirSync(folder)).toEqual([])
  })

  it('a second stream in the same second gets its own name; resume keeps the same file', () => {
    writeFileSync(join(folder, '2026Sep28-104512-Live.wav'), 'x')
    const rec = new RealtimeRecorder(deps)
    rec.start()
    expect(rec.start()).toBeNull()
    rec.write(packet([1, 1]))
    expect(rec.finish()).toMatchObject({ filename: '2026Sep28-104512-Live-2.wav' })
  })

  it('recovers a stream a crash cut off', () => {
    const body = Buffer.alloc(10)
    body.writeInt16LE(4, 0)
    writeFileSync(join(folder, '2026Sep28-104512-Live.wav.partial'), Buffer.concat([wavHeader(0), body]))
    writeFileSync(join(folder, '2026Sep28-110000-Live.wav.partial'), wavHeader(0))
    expect(recoverPartialLiveRecordings(folder)).toEqual([join(folder, '2026Sep28-104512-Live.wav')])
    const bytes = readFileSync(join(folder, '2026Sep28-104512-Live.wav'))
    expect(bytes.readUInt32LE(40)).toBe(8)
    expect(readdirSync(folder)).toEqual(['2026Sep28-104512-Live.wav'])
  })

  it('recovers under the next free name when the name is taken', () => {
    writeFileSync(join(folder, '2026Sep28-104512-Live.wav'), 'kept')
    writeFileSync(join(folder, '2026Sep28-104512-Live.wav.partial'), Buffer.concat([wavHeader(0), Buffer.alloc(4)]))
    expect(recoverPartialLiveRecordings(folder)).toEqual([join(folder, '2026Sep28-104512-Live-2.wav')])
    expect(readFileSync(join(folder, '2026Sep28-104512-Live.wav'), 'utf8')).toBe('kept')
  })

  it('notes which channel was the microphone next to the file', () => {
    const rec = new RealtimeRecorder({ ...deps, micChannel: () => 1 })
    rec.start()
    rec.write(packet([1, 2]))
    rec.finish()
    expect(JSON.parse(readFileSync(join(folder, '2026Sep28-104512-Live.live.json'), 'utf8'))).toEqual({ micChannel: 1 })
  })
})
