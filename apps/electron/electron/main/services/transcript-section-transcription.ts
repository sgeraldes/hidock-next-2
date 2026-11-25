import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegPath from 'ffmpeg-static'
import type { TimingSegment } from '../../../src/shared/transcript-timing'

/**
 * "Transcribe this section again": cut the stretch of audio where a range of
 * lines belongs and transcribe only that. The owner starts it with a click
 * and a confirmation; nothing calls it on its own. The provider call is a
 * dependency, so tests pass a mock and never reach a paid API.
 */

/** Longer than this is not a section; it is a new transcription of the recording. */
export const MAX_SECTION_SECONDS = 15 * 60
/** Audio kept on each side, so the first and last words are not cut. */
export const SECTION_PAD_SECONDS = 1

export interface SectionTranscript {
  fullText: string
  /** The provider's segments as JSON, times relative to the slice. */
  speakers?: string
}

export interface SectionDeps {
  /** Write [start, start + seconds) of the recording to a 16 kHz WAV at outPath. */
  extract: (audioPath: string, start: number, seconds: number, outPath: string) => Promise<void>
  transcribe: (slicePath: string, seconds: number) => Promise<SectionTranscript>
}

export function extractWithFfmpeg(audioPath: string, start: number, seconds: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('Bundled decoder unavailable')); return }
    const child = spawn(ffmpegPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', audioPath, '-ss', String(start), '-t', String(seconds),
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Section audio extraction exited ${code}`)))
  })
}

/** The stretch to transcribe for a window, padded and bounded. */
export function sectionBounds(windowStart: number, windowEnd: number, durationSeconds: number | null): { start: number; seconds: number } {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    throw new Error('Where this section belongs is unknown, so it cannot be transcribed on its own')
  }
  const start = Math.max(0, windowStart - SECTION_PAD_SECONDS)
  const end = durationSeconds ? Math.min(durationSeconds, windowEnd + SECTION_PAD_SECONDS) : windowEnd + SECTION_PAD_SECONDS
  const seconds = end - start
  if (seconds > MAX_SECTION_SECONDS) {
    throw new Error(`This section spans ${Math.round(seconds / 60)} minutes; transcribe the whole recording again instead`)
  }
  return { start, seconds }
}

export interface SectionOptions {
  /** The flagged window; the padding around it may hold the trusted neighbour lines. */
  window: { start: number; end: number }
  /** Names this run's voices apart from every other run's, for example "Section 1a2b3c4d". */
  label: string
}

/**
 * The provider's lines moved to the recording's clock and kept inside the
 * flagged window. A line wholly in the padding is a neighbour line heard
 * again and is dropped; a line across the window's edge is clipped to it.
 */
export function sectionSegments(result: SectionTranscript, bounds: { start: number; seconds: number }, options: SectionOptions): TimingSegment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(result.speakers ?? '[]')
  } catch {
    throw new Error('The section transcription returned unreadable lines')
  }
  const { window, label } = options
  const rows = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : []
  const lines: TimingSegment[] = []
  for (const row of rows) {
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    if (!text) continue
    const at = typeof row.start === 'number' && Number.isFinite(row.start) ? row.start : 0
    const until = typeof row.end === 'number' && Number.isFinite(row.end) ? row.end : at
    const lineStart = bounds.start + Math.min(Math.max(0, at), bounds.seconds)
    const lineEnd = Math.max(lineStart, bounds.start + Math.min(Math.max(0, until), bounds.seconds))
    if (lineEnd <= window.start || lineStart >= window.end) continue
    const clippedStart = Math.max(window.start, lineStart)
    lines.push({
      start: clippedStart,
      end: Math.max(clippedStart, Math.min(window.end, lineEnd)),
      text,
      // Provider labels name voices within this one request only, so each run
      // gets its own namespace, as the smaller-chunk retry labels its slices.
      ...(typeof row.speaker === 'string' && row.speaker ? { speaker: `${label} / ${row.speaker}` } : {})
    })
  }
  if (!lines.length && !rows.length && result.fullText.trim()) lines.push({ start: window.start, end: window.end, text: result.fullText.trim() })
  if (!lines.length) throw new Error('The section transcription found no speech in this section')
  return lines.sort((a, b) => a.start - b.start)
}

export async function transcribeSection(
  audioPath: string, bounds: { start: number; seconds: number }, deps: SectionDeps, options: SectionOptions
): Promise<TimingSegment[]> {
  const dir = await mkdtemp(join(tmpdir(), 'hidock-section-'))
  try {
    const slice = join(dir, 'section.wav')
    await deps.extract(audioPath, bounds.start, bounds.seconds, slice)
    const result = await deps.transcribe(slice, bounds.seconds)
    return sectionSegments(result, bounds, options)
  } finally {
    // Only this invocation's own temporary directory.
    await rm(dir, { recursive: true, force: true })
  }
}
