/**
 * Audio profiles on disk and in the database, and the pass that fills them.
 *
 * Spec: docs/superpowers/specs/2026-09-24-recording-checks-design.md
 *
 * One profile per recording, computed once and reused: the summary row in
 * `audio_profiles` (what the Library filters and labels on), the per-frame
 * envelope as a file in the cache folder (one byte per 36 ms frame, for the
 * waveform and later stages). A profile is current while its rule version, the
 * file size and the file's modification time match; otherwise it is computed
 * again.
 *
 * Silent, noise-only and too-short recordings are rated "no value" through the
 * same guarded path the duration gate uses: AI ratings are replaced (audio
 * with no sound outranks a rating of text the transcriber invented for it), a
 * rating the owner set is never touched.
 */

import { existsSync, mkdirSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { queryAll, queryOne, run } from './database'
import { getCachePath } from './file-storage'
import {
  AUDIO_PROFILE_VERSION,
  profileAudioFile,
  type AudioCategory,
  type AudioProfile,
} from './audio-profile'
import { applyCaptureValueClassification, type ValueClassification } from './value-classification'

export interface AudioProfileRow {
  recording_id: string
  version: number
  method: string
  file_size: number | null
  file_mtime_ms: number | null
  duration_seconds: number | null
  sound_seconds: number | null
  sound_share: number | null
  longest_sound_seconds: number | null
  median_level: number | null
  spike_count: number | null
  category: AudioCategory
  ranges_json: string | null
  computed_at: string
}

export function envelopePath(recordingId: string): string {
  return join(getCachePath(), 'audio-envelope', `${recordingId}.u8`)
}

export function getAudioProfile(recordingId: string): AudioProfileRow | null {
  return queryOne<AudioProfileRow>('SELECT * FROM audio_profiles WHERE recording_id = ?', [recordingId]) ?? null
}

export function isProfileCurrent(row: AudioProfileRow | null, size: number, mtimeMs: number): boolean {
  return !!row && row.version === AUDIO_PROFILE_VERSION && row.file_size === size && row.file_mtime_ms === Math.round(mtimeMs)
}

/** Verdicts that rate a recording "no value"; speech changes no rating. */
const VALUE_BY_CATEGORY: Partial<Record<AudioCategory, ValueClassification>> = {
  silent: { value: 'none', reasons: ['silent_audio'], confidence: 1 },
  noise: { value: 'none', reasons: ['noise_only'], confidence: 1 },
  too_short: { value: 'none', reasons: ['no_substance'], confidence: 1 },
}

/** Rate the recording's captures from its audio. Returns how many were changed. */
export function applyAudioValueVerdict(recordingId: string, category: AudioCategory): number {
  const verdict = VALUE_BY_CATEGORY[category]
  if (!verdict) return 0
  const captures = queryAll<{ id: string }>(
    `SELECT id FROM knowledge_captures
      WHERE source_recording_id = ? AND deleted_at IS NULL AND COALESCE(quality_source, '') != 'user'`,
    [recordingId]
  )
  let changed = 0
  for (const capture of captures) {
    if (applyCaptureValueClassification(capture.id, verdict, 'audio').applied) changed++
  }
  return changed
}

export interface ProfileOutcome {
  recordingId: string
  profile: AudioProfile | null
  /** Why no profile was computed. */
  skipped?: 'no-file' | 'current'
  capturesRated: number
}

/**
 * Profile one recording now (or return early when its profile is current and
 * `force` is not set). Reads the whole file once; a 4-hour recording is about
 * 115 MB and scans in tens of milliseconds.
 */
export async function profileRecording(
  recording: { id: string; file_path: string | null },
  options: { force?: boolean; decode?: (path: string) => Promise<Float32Array> } = {}
): Promise<ProfileOutcome> {
  if (!recording.file_path || !existsSync(recording.file_path)) {
    return { recordingId: recording.id, profile: null, skipped: 'no-file', capturesRated: 0 }
  }
  const stat = statSync(recording.file_path)
  if (!options.force && isProfileCurrent(getAudioProfile(recording.id), stat.size, stat.mtimeMs)) {
    return { recordingId: recording.id, profile: null, skipped: 'current', capturesRated: 0 }
  }
  const buf = await readFile(recording.file_path)
  const profile = await profileAudioFile(buf, recording.file_path, options.decode)

  const dir = join(getCachePath(), 'audio-envelope')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  await writeFile(envelopePath(recording.id), profile.envelope)

  run(
    `INSERT INTO audio_profiles (recording_id, version, method, file_size, file_mtime_ms, duration_seconds,
        sound_seconds, sound_share, longest_sound_seconds, median_level, spike_count, category, ranges_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET
        version = excluded.version, method = excluded.method, file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms, duration_seconds = excluded.duration_seconds,
        sound_seconds = excluded.sound_seconds, sound_share = excluded.sound_share,
        longest_sound_seconds = excluded.longest_sound_seconds, median_level = excluded.median_level,
        spike_count = excluded.spike_count, category = excluded.category, ranges_json = excluded.ranges_json,
        computed_at = excluded.computed_at`,
    [
      recording.id,
      profile.version,
      profile.method,
      stat.size,
      Math.round(stat.mtimeMs),
      profile.durationSeconds,
      profile.soundSeconds,
      profile.soundShare,
      profile.longestSoundSeconds,
      profile.medianLevel,
      profile.spikeCount,
      profile.category,
      JSON.stringify(profile.ranges),
      new Date().toISOString(),
    ]
  )
  const capturesRated = applyAudioValueVerdict(recording.id, profile.category)
  return { recordingId: recording.id, profile, capturesRated }
}

export interface BackfillProgress {
  total: number
  done: number
  profiled: number
  byCategory: Record<AudioCategory, number>
  capturesRated: number
  failed: number
}

/**
 * Recordings whose profile is missing or from an older rule version. Files
 * that changed on disk are caught when they are profiled (size and mtime).
 */
export function recordingsNeedingProfile(): { id: string; file_path: string | null }[] {
  return queryAll<{ id: string; file_path: string | null }>(
    `SELECT r.id, r.file_path
       FROM recordings r
       LEFT JOIN audio_profiles ap ON ap.recording_id = r.id
      WHERE r.deleted_at IS NULL
        AND r.file_path IS NOT NULL AND r.file_path != ''
        AND (ap.recording_id IS NULL OR ap.version != ?)
      ORDER BY r.date_recorded DESC`,
    [AUDIO_PROFILE_VERSION]
  )
}

/** Tell the windows that labels and ratings may have changed. */
async function announce(progress: Pick<BackfillProgress, 'profiled' | 'byCategory' | 'capturesRated'>): Promise<void> {
  if (progress.profiled === 0) return
  try {
    const { getEventBus } = await import('./event-bus')
    getEventBus().emitDomainEvent({
      type: 'audio:profiles-updated',
      timestamp: new Date().toISOString(),
      payload: {
        profiled: progress.profiled,
        silent: progress.byCategory.silent,
        noise: progress.byCategory.noise,
        tooShort: progress.byCategory.too_short,
        capturesRated: progress.capturesRated,
      },
    })
  } catch (error) {
    console.warn('[AudioProfile] could not announce the update:', error)
  }
}

/** Profile one recording on request (Re-process, or a check that found something wrong) and announce it. */
export async function profileRecordingNow(recordingId: string): Promise<ProfileOutcome> {
  const recording = queryOne<{ id: string; file_path: string | null }>(
    'SELECT id, file_path FROM recordings WHERE id = ? AND deleted_at IS NULL',
    [recordingId]
  )
  if (!recording) throw new Error('No such recording')
  const outcome = await profileRecording(recording, { force: true })
  if (outcome.profile) {
    const byCategory = { too_short: 0, silent: 0, noise: 0, speech: 0 } as Record<AudioCategory, number>
    byCategory[outcome.profile.category] = 1
    await announce({ profiled: 1, byCategory, capturesRated: outcome.capturesRated })
  }
  return outcome
}

let running: Promise<BackfillProgress> | null = null

/**
 * Profile every recording that needs it, one at a time, yielding between
 * files so the app stays responsive. `pauseWhile` lets a heavier job (a
 * transcription in progress) take the machine; the pass waits and resumes.
 * One pass at a time: a second call returns the running one.
 */
export function backfillAudioProfiles(
  options: {
    gapMs?: number
    /** Tests: decode without ffmpeg. */
    decode?: (path: string) => Promise<Float32Array>
    pauseWhile?: () => boolean
    shouldStop?: () => boolean
    onProgress?: (progress: BackfillProgress) => void
  } = {}
): Promise<BackfillProgress> {
  if (running) return running
  const gapMs = options.gapMs ?? 25
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  running = (async () => {
    const todo = recordingsNeedingProfile()
    const progress: BackfillProgress = {
      total: todo.length,
      done: 0,
      profiled: 0,
      byCategory: { too_short: 0, silent: 0, noise: 0, speech: 0 },
      capturesRated: 0,
      failed: 0,
    }
    for (const recording of todo) {
      if (options.shouldStop?.()) break
      while (options.pauseWhile?.() && !options.shouldStop?.()) await wait(5000)
      try {
        const outcome = await profileRecording(recording, { decode: options.decode })
        if (outcome.profile) {
          progress.profiled++
          progress.byCategory[outcome.profile.category]++
          progress.capturesRated += outcome.capturesRated
        }
      } catch (error) {
        progress.failed++
        console.warn(`[AudioProfile] ${recording.id}: ${error instanceof Error ? error.message : error}`)
      }
      progress.done++
      options.onProgress?.(progress)
      await wait(gapMs)
    }
    const { too_short, silent, noise, speech } = progress.byCategory
    console.log(
      `[AudioProfile] profiled ${progress.profiled}/${progress.total}: ${speech} speech, ${noise} noise only, ` +
        `${silent} silent, ${too_short} too short; ${progress.capturesRated} capture(s) rated no value` +
        (progress.failed ? `; ${progress.failed} failed` : '')
    )
    await announce(progress)
    return progress
  })().finally(() => {
    running = null
  })
  return running
}
