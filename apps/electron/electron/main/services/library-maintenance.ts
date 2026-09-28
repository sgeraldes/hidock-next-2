/**
 * Library maintenance: the jobs behind the Settings maintenance card.
 *
 * - Re-check warnings: recompute the stored audio-versus-transcript warnings
 *   from stored numbers (no Jev call).
 * - Relink recordings to meetings: pull the Microsoft 365 calendar back to the
 *   oldest recording, then run the time-overlap linker on unlinked recordings.
 * - Redraw waveforms: a coarse waveform for every recording from the loudness
 *   envelope the audio check already stored (no decoding). The player replaces
 *   it with the exact one the first time the recording is opened.
 * - Rescan with Jev lives in value-backfill (startValueBackfill); the card can
 *   first mark every evaluation outdated so the pass evaluates all of them again.
 *
 * Owner request, 28-sep-2026.
 */

import { readFile, stat } from 'fs/promises'
import { queryAll, queryOne, run } from './database'
import { envelopePath } from './audio-profile-store'
import { getWaveformCache, setWaveformCache } from './waveform-cache'
import { recomputeAudioWarnings } from './value-classification'

/** Peaks per waveform, the same count the player computes when it decodes. */
export const WAVEFORM_PEAKS = 1000

/**
 * Frame gain to amplitude: one MP3 global_gain step is a quarter of an octave
 * in amplitude (1.5 dB). The offset was fitted against 105 recordings that had
 * both an envelope and a decoded waveform (28-sep-2026): shape correlation 0.68,
 * close enough for a first look, and the exact one replaces it on first play.
 */
export const GAIN_AMPLITUDE_OFFSET = 167

/** Build waveform peaks from a frame-gain envelope (one byte per 36 ms frame). */
export function peaksFromEnvelope(envelope: Uint8Array, count = WAVEFORM_PEAKS): number[] {
  if (envelope.length === 0) return []
  const n = Math.min(count, envelope.length)
  const peaks = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * envelope.length) / n)
    const to = Math.max(from + 1, Math.floor(((i + 1) * envelope.length) / n))
    let max = 0
    for (let j = from; j < to; j++) if (envelope[j] > max) max = envelope[j]
    peaks[i] = max === 0 ? 0 : Math.min(1, Math.pow(2, (max - GAIN_AMPLITUDE_OFFSET) / 4))
  }
  return peaks
}

export interface WaveformRedrawResult {
  total: number
  drawn: number
  keptExact: number
  noEnvelope: number
}

let redrawRunning = false

/** Longest stretch the redraw keeps the main process busy before it yields. */
const REDRAW_YIELD_MS = 20

/**
 * Coarse waveform for every recording that has an envelope and no exact
 * waveform for its current file. File reads are asynchronous and the loop
 * yields every REDRAW_YIELD_MS, so a slow disk does not stall the windows.
 * One pass at a time.
 */
export async function redrawWaveforms(onProgress?: (done: number, total: number) => void): Promise<WaveformRedrawResult | { busy: true }> {
  if (redrawRunning) return { busy: true }
  redrawRunning = true
  try {
    const rows = queryAll<{ id: string; file_path: string | null; duration_seconds: number | null }>(
      `SELECT r.id, r.file_path, COALESCE(ap.duration_seconds, r.duration_seconds) AS duration_seconds
         FROM recordings r
         JOIN audio_profiles ap ON ap.recording_id = r.id
        WHERE r.deleted_at IS NULL`
    )
    const result: WaveformRedrawResult = { total: rows.length, drawn: 0, keptExact: 0, noEnvelope: 0 }
    let lastYield = Date.now()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const fileSize = row.file_path ? await fileSizeOf(row.file_path) : 0
      // An exact waveform counts only for the file as it is now: a replaced or
      // repaired file (another size) gets a fresh one.
      const existing = getWaveformCache(row.id, fileSize || undefined)
      if (existing && !existing.coarse) {
        result.keptExact++
      } else {
        const envelope = await readFile(envelopePath(row.id)).catch(() => null)
        if (!envelope) {
          result.noEnvelope++
        } else {
          const peaks = peaksFromEnvelope(new Uint8Array(envelope))
          if (peaks.length > 0 && setWaveformCache(row.id, peaks, row.duration_seconds ?? 0, fileSize, true)) result.drawn++
        }
      }
      if (Date.now() - lastYield >= REDRAW_YIELD_MS) {
        onProgress?.(i + 1, rows.length)
        await new Promise<void>((resolve) => setImmediate(resolve))
        lastYield = Date.now()
      }
    }
    onProgress?.(rows.length, rows.length)
    return result
  } finally {
    redrawRunning = false
  }
}

async function fileSizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Re-check warnings: recompute every stored audio-versus-transcript warning. */
export async function recheckWarnings(): Promise<{ changed: number; evaluated: number }> {
  const changed = await recomputeAudioWarnings()
  const evaluated = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM recording_evaluations')?.n ?? 0
  return { changed, evaluated }
}

/** Mark every stored evaluation outdated, so the next value backfill evaluates all of them again. */
export function markEvaluationsOutdated(): number {
  run('UPDATE recording_evaluations SET version = 0')
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM recording_evaluations')?.n ?? 0
}

/** Sync rounds one relink may take per account (each round is up to 50 Graph pages). */
export const MAX_RELINK_SYNC_ROUNDS = 40

export interface RelinkResult {
  unlinkedBefore: number
  unlinkedAfter: number
  linked: number
  meetingsSynced: number
  historyFrom: string | null
  accounts: number
  errors: string[]
}

function unlinkedCount(): number {
  return (
    queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM recordings WHERE deleted_at IS NULL AND meeting_id IS NULL AND date_recorded IS NOT NULL'
    )?.n ?? 0
  )
}

/**
 * Relink recordings to meetings. Every connected Microsoft 365 account pulls
 * its calendar from the oldest recording onward (the connector normally reads
 * only the last 30 days), then the time-overlap linker runs on every unlinked
 * recording. Links a person set are never touched: the linker only fills
 * recordings with no meeting.
 */
export async function relinkRecordingsToMeetings(): Promise<RelinkResult> {
  const oldest = queryOne<{ first: string | null }>(
    'SELECT MIN(date_recorded) AS first FROM recordings WHERE deleted_at IS NULL AND date_recorded IS NOT NULL'
  )?.first
  const historyFrom = oldest ? new Date(new Date(oldest).getTime() - 86_400_000).toISOString() : null
  const result: RelinkResult = {
    unlinkedBefore: unlinkedCount(),
    unlinkedAfter: 0,
    linked: 0,
    meetingsSynced: 0,
    historyFrom,
    accounts: 0,
    errors: []
  }

  const { getConnectorHost } = await import('./connectors')
  const { getConnectorStore } = await import('./connectors/connector-store')
  const host = getConnectorHost()
  const store = getConnectorStore()
  for (const id of host.listInstances()) {
    const summary = host.summary(id)
    if (summary.descriptor.id !== 'm365' || summary.status.state !== 'connected') continue
    result.accounts++
    try {
      if (historyFrom) store.setConfig(id, { calendarHistoryStart: historyFrom })
      // A fresh window needs a fresh delta query: the saved cursor only covers the old one.
      store.setSourceState(id, 'calendar', { cursor: null })
      // A sync stops after its page cap with the next page saved; keep going
      // until the calendar is complete, or linking would run on part of it.
      for (let round = 0; round < MAX_RELINK_SYNC_ROUNDS; round++) {
        const outcome = await host.syncNow(id, 'calendar')
        result.meetingsSynced += outcome.meetings
        if (!outcome.truncated) break
        if (round === MAX_RELINK_SYNC_ROUNDS - 1) {
          result.errors.push(`${summary.label}: calendar history is longer than ${MAX_RELINK_SYNC_ROUNDS} sync rounds; run Relink again to continue.`)
        }
      }
    } catch (error) {
      result.errors.push(`${summary.label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const { autoLinkRecordingsToMeetings } = await import('./org-reconciler')
  result.linked = autoLinkRecordingsToMeetings()
  result.unlinkedAfter = unlinkedCount()
  return result
}
