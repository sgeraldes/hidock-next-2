/**
 * Waveform peak cache (main process, disk-backed).
 *
 * Waveform peaks are expensive to compute (decode the whole audio file, then
 * downsample). We compute them ONCE per recording and persist the result to disk
 * so subsequent opens load instantly with no "computing" state.
 *
 * Storage: one JSON file per recording under `<userData>/cache/waveform/<id>.json`.
 * Keyed by recording id.
 *
 * Invalidation:
 *  - Keep the cache version stable for additive metadata; legacy complete
 *    entries remain usable and incomplete coarse entries are repaired lazily.
 *  - Callers may pass the current size and stable source fingerprint; mismatch
 *    treats the entry as stale, including same-size replacements.
 *  - `clearWaveformCache(id)` removes a single entry.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getCachePath } from './file-storage'

/** Version 2 remains compatible; source identity is an additive cache field. */
export const CACHE_VERSION = 2

export interface WaveformCacheEntry {
  version: number
  recordingId: string
  /** Normalised amplitude peaks in [0, 1]. */
  peaks: number[]
  channels?: number[][]
  /** Number of peaks (== peaks.length). */
  sampleCount: number
  /** Audio duration in seconds (0 if unknown at write time). */
  duration: number
  /** Source audio file size in bytes (0 if unknown) — used for change detection. */
  fileSize: number
  /** Stable metadata identity of the source file at decode time. */
  sourceFingerprint?: string
  createdAt: string
  /**
   * Drawn from the stored loudness envelope, not decoded (library-maintenance).
   * The player shows it at once and replaces it with the decoded one.
   */
  coarse?: boolean
}

function getWaveformCacheDir(): string {
  const dir = join(getCachePath(), 'waveform')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Sanitise a recording id into a safe filename stem. */
function safeStem(recordingId: string): string {
  return String(recordingId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200)
}

function entryPath(recordingId: string): string {
  return join(getWaveformCacheDir(), `${safeStem(recordingId)}.json`)
}

/**
 * Load cached peaks for a recording. Returns null on miss / stale / corruption.
 *
 * @param recordingId  Recording id key.
 * @param fileSize     Optional current audio file size for change detection.
 */
export function getWaveformCache(recordingId: string, fileSize?: number, sourceFingerprint?: string): WaveformCacheEntry | null {
  if (!recordingId) return null
  try {
    const p = entryPath(recordingId)
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as WaveformCacheEntry
    if (!parsed || parsed.version !== CACHE_VERSION) return null
    if (!Array.isArray(parsed.peaks) || parsed.peaks.length === 0) return null
    // Change detection: if we know both sizes and they differ, the file changed.
    if (fileSize && parsed.fileSize && fileSize !== parsed.fileSize) return null
    if (sourceFingerprint && parsed.sourceFingerprint && parsed.sourceFingerprint !== sourceFingerprint) return null
    return parsed
  } catch (err) {
    console.warn('[WaveformCache] Failed to read entry:', recordingId, err)
    return null
  }
}

/**
 * Persist peaks for a recording.
 *
 * @returns true on success, false on failure (caller can still proceed).
 */
export function setWaveformCache(
  recordingId: string,
  peaks: number[],
  duration = 0,
  fileSize = 0,
  coarse = false,
  channels?: number[][],
  sourceFingerprint?: string
): boolean {
  if (!recordingId || !Array.isArray(peaks) || peaks.length === 0) return false
  try {
    const entry: WaveformCacheEntry = {
      version: CACHE_VERSION,
      recordingId,
      peaks,
      ...(channels ? { channels } : {}),
      sampleCount: peaks.length,
      duration: Number.isFinite(duration) ? duration : 0,
      fileSize: Number.isFinite(fileSize) ? fileSize : 0,
      ...(sourceFingerprint ? { sourceFingerprint } : {}),
      createdAt: new Date().toISOString(),
      ...(coarse ? { coarse: true } : {})
    }
    writeFileSync(entryPath(recordingId), JSON.stringify(entry))
    return true
  } catch (err) {
    console.warn('[WaveformCache] Failed to write entry:', recordingId, err)
    return false
  }
}

/** Remove a single cached entry. Returns true if removed (or already absent). */
export function clearWaveformCache(recordingId: string): boolean {
  if (!recordingId) return false
  try {
    const p = entryPath(recordingId)
    if (existsSync(p)) unlinkSync(p)
    return true
  } catch (err) {
    console.warn('[WaveformCache] Failed to clear entry:', recordingId, err)
    return false
  }
}
