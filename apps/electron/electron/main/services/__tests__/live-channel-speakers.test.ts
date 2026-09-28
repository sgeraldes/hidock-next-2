/**
 * The owner is named on the microphone speaker of a saved live stream.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { channelEnergyBySpeaker, microphoneSpeaker, nameOwnerOnLiveRecording, parseWavLayout, type LiveOwnerDeps } from '../live-channel-speakers'
import { wavHeader } from '../realtime-recorder'

const RATE = 16000
let dir = ''
let wav = ''

/** 20 s of stereo: 0-10 s loud on the left (the microphone), 10-20 s loud on the right. */
function makeWav(path: string) {
  const frames = RATE * 20
  const pcm = Buffer.alloc(frames * 4)
  for (let f = 0; f < frames; f++) {
    const loud = Math.round(8000 * Math.sin(f / 7))
    const quiet = Math.round(200 * Math.sin(f / 7))
    const left = f < RATE * 10 ? loud : quiet
    const right = f < RATE * 10 ? quiet : loud
    pcm.writeInt16LE(left, f * 4)
    pcm.writeInt16LE(right, f * 4 + 2)
  }
  writeFileSync(path, Buffer.concat([wavHeader(pcm.length), pcm]))
}

const segments = [
  { speaker: 'SPEAKER_00', start: 0, end: 10 },
  { speaker: 'SPEAKER_01', start: 10, end: 20 }
]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-owner-'))
  wav = join(dir, '2026Sep28-104512-Live.wav')
  makeWav(wav)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function deps(over: Partial<LiveOwnerDeps> = {}): LiveOwnerDeps & { assigned: string[] } {
  const assigned: string[] = []
  return {
    assigned,
    recording: () => ({ filename: '2026Sep28-104512-Live.wav', file_path: wav }),
    segments: () => segments,
    speakerMap: () => [],
    ownerContactId: () => 'contact-me',
    micChannel: () => 0,
    assign: (_id, label, contact) => assigned.push(`${label}=${contact}`),
    ...over
  }
}

describe('live stream owner', () => {
  it('reads only 16-bit stereo PCM', () => {
    expect(parseWavLayout(wavHeader(100))).toMatchObject({ dataOffset: 44, dataBytes: 100, sampleRate: RATE })
    const mono = wavHeader(100)
    mono.writeUInt16LE(1, 22)
    expect(parseWavLayout(mono)).toBeNull()
  })

  it('finds which speaker sits on the microphone channel', async () => {
    const energy = await channelEnergyBySpeaker(wav, segments, 0)
    expect(microphoneSpeaker(energy)).toBe('SPEAKER_00')
    expect(microphoneSpeaker(await channelEnergyBySpeaker(wav, segments, 1))).toBe('SPEAKER_01')
  })

  it('names the owner on that speaker', async () => {
    const d = deps()
    expect(await nameOwnerOnLiveRecording('r1', d)).toEqual({ named: true, label: 'SPEAKER_00' })
    expect(d.assigned).toEqual(['SPEAKER_00=contact-me'])
  })

  it('names nobody when it is not clear or not allowed', async () => {
    const cases: Array<[Partial<LiveOwnerDeps>, RegExp]> = [
      [{ recording: () => ({ filename: 'Rec01.wav', file_path: wav }) }, /not a live/],
      [{ ownerContactId: () => null }, /no owner/],
      [{ micChannel: () => null }, /not noted/],
      [{ speakerMap: () => [{ speaker_label: 'SPEAKER_01', contact_id: 'contact-me' }] }, /already named here/],
      [{ speakerMap: () => [{ speaker_label: 'SPEAKER_00', contact_id: 'someone' }] }, /already named/],
      [{ segments: () => [{ speaker: 'A', start: 0, end: 5 }, { speaker: 'B', start: 5, end: 10 }] }, /no single speaker/]
    ]
    for (const [over, reason] of cases) {
      const d = deps(over)
      const r = await nameOwnerOnLiveRecording('r1', d)
      expect(r.named).toBe(false)
      if (!r.named) expect(r.reason).toMatch(reason)
      expect(d.assigned).toEqual([])
    }
  })
})
