// @vitest-environment node

/**
 * Audio profiles against a real SQLite database and real files: a profile is
 * stored once and reused, a changed file is checked again, silent and noise-only
 * recordings are rated "no value" (replacing an AI rating, never the owner's),
 * and the Library's rows carry the category.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '', cache: '' }))
paths.db = join(tmpdir(), `hidock-audio-profile-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
  getCachePath: () => paths.cache,
}))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { valueClassificationMinConfidence: 0.6 } }),
}))
// The event bus needs a window; nothing here listens.
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent: vi.fn() }) }))

import { initializeDatabase, closeDatabase, run, queryOne, getRecordings } from '../database'
import {
  backfillAudioProfiles,
  envelopePath,
  getAudioProfile,
  profileRecording,
  recordingsNeedingProfile,
} from '../audio-profile-store'
import { FRAME_SECONDS, scanDeviceMp3 } from '../audio-profile'
import { readFileSync } from 'fs'

/** What decoding would find for these synthetic files: loud where the gain is loud. */
const decode = async (path: string) =>
  Float32Array.from(scanDeviceMp3(readFileSync(path))!, (gain) => (gain > 142 ? -20 : -70))

let dir = ''

function frame(gain: number): Buffer {
  const f = Buffer.alloc(288)
  f[0] = 0xff
  f[1] = 0xf3
  f[2] = 0x88
  f[3] = 0xc4
  f[7] = (gain >> 6) & 0x03
  f[8] = (gain << 2) & 0xff
  return f
}
function audio(pieces: Array<[number, number]>): Buffer {
  const out: Buffer[] = []
  for (const [gain, seconds] of pieces) for (let i = 0; i < Math.round(seconds / FRAME_SECONDS); i++) out.push(frame(gain))
  return Buffer.concat(out)
}

function seedRecording(id: string, content: Buffer | null): string | null {
  const file = content ? join(dir, `${id}.wav`) : null
  if (file && content) writeFileSync(file, content)
  run(
    `INSERT INTO recordings (id, filename, file_path, date_recorded, status, location, transcription_status,
        on_device, on_local, source, is_imported)
     VALUES (?, ?, ?, '2026-09-23T10:00:00.000Z', 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0)`,
    [id, `${id}.wav`, file]
  )
  return file
}

function seedCapture(id: string, recordingId: string, rating: string, source: 'ai' | 'user' | null): void {
  run(
    `INSERT INTO knowledge_captures (id, title, source_recording_id, quality_rating, quality_source, captured_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-23T10:00:00.000Z')`,
    [id, `Capture ${id}`, recordingId, rating, source]
  )
}

const rating = (captureId: string) =>
  queryOne<{ quality_rating: string; quality_method: string | null; quality_reasons: string | null }>(
    'SELECT quality_rating, quality_method, quality_reasons FROM knowledge_captures WHERE id = ?',
    [captureId]
  )

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hidock-audio-'))
  paths.cache = join(dir, 'cache')
  mkdirSync(paths.cache, { recursive: true })
  await initializeDatabase()
  seedRecording('silent', audio([[138, 20]]))
  seedRecording('talk', audio([[138, 5], [165, 20], [138, 5]]))
  seedRecording('knocks', audio([[138, 12], [170, 0.3], [138, 12], [170, 0.3], [138, 12]]))
  seedRecording('gone', null)
  seedCapture('c-silent-ai', 'silent', 'valuable', 'ai')
  seedCapture('c-silent-user', 'silent', 'valuable', 'user')
  seedCapture('c-talk', 'talk', 'valuable', 'ai')
  seedCapture('c-knocks', 'knocks', 'unrated', null)
})

afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('audio profiles on the library', () => {
  it('lists every recording with a file and no profile', () => {
    expect(recordingsNeedingProfile().map((r) => r.id).sort()).toEqual(['knocks', 'silent', 'talk'])
  })

  it('profiles the library, rates silent and noise-only recordings, and leaves speech alone', async () => {
    const progress = await backfillAudioProfiles({ gapMs: 0, decode })
    expect(progress.profiled).toBe(3)
    expect(progress.byCategory).toMatchObject({ silent: 1, noise: 1, speech: 1 })
    expect(getAudioProfile('silent')?.category).toBe('silent')
    expect(getAudioProfile('knocks')?.category).toBe('noise')
    expect(getAudioProfile('talk')?.category).toBe('speech')

    // An AI rating of an invented transcript gives way to the audio.
    expect(rating('c-silent-ai')).toMatchObject({ quality_rating: 'garbage', quality_method: 'audio' })
    expect(JSON.parse(rating('c-silent-ai')!.quality_reasons!)).toEqual(['silent_audio'])
    expect(rating('c-knocks')?.quality_rating).toBe('garbage')
    // The owner's own rating is never touched, and speech changes nothing.
    expect(rating('c-silent-user')?.quality_rating).toBe('valuable')
    expect(rating('c-talk')?.quality_rating).toBe('valuable')

    expect(existsSync(envelopePath('talk'))).toBe(true)
    expect(recordingsNeedingProfile()).toEqual([])
  })

  it('does not read a file again while it is unchanged, and does when it changes', async () => {
    expect((await profileRecording({ id: 'talk', file_path: join(dir, 'talk.wav') })).skipped).toBe('current')
    writeFileSync(join(dir, 'talk.wav'), audio([[138, 30]]))
    const again = await profileRecording({ id: 'talk', file_path: join(dir, 'talk.wav') }, { decode })
    expect(again.profile?.category).toBe('silent')
  })

  it('skips a recording whose file is not on this computer', async () => {
    expect((await profileRecording({ id: 'gone', file_path: null })).skipped).toBe('no-file')
  })

  it('gives the Library rows their category', () => {
    const rows = getRecordings()
    expect(rows.find((r) => r.id === 'knocks')?.audio_category).toBe('noise')
    expect(rows.find((r) => r.id === 'gone')?.audio_category ?? null).toBeNull()
  })
})
