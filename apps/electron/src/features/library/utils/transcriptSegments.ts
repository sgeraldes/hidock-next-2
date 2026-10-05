import type { StoredSegment } from '../components/TranscriptViewer'
import { expandInlineStoredSegments } from './splitInlineTurns'
export interface TranscriptSegment {
  startMs: number
  endMs?: number
  text: string
  speaker?: string
  /** Carried from storage so saving a correction keeps them. */
  speakerAttribution?: string
  speakerConfidence?: number
}

/**
 * Break a plain, unstructured transcript into readable paragraphs so an
 * old-style single-blob transcript (no newlines, no speaker labels) doesn't
 * render as one unbroken wall of text. Splits on existing newlines first, then
 * subdivides any long run into ~sentence groups.
 */
export function toParagraphs(text: string): string[] {
  const paragraphs: string[] = []
  for (const block of text.split(/\n+/).map((b) => b.trim()).filter(Boolean)) {
    if (block.length <= 600) {
      paragraphs.push(block)
      continue
    }
    const sentences = block.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [block]
    let current = ''
    for (const sentence of sentences) {
      current += sentence
      if (current.length >= 350) {
        paragraphs.push(current.trim())
        current = ''
      }
    }
    if (current.trim()) paragraphs.push(current.trim())
  }
  return paragraphs.length > 0 ? paragraphs : [text.trim()]
}

/** Map stored (seconds-based) segments to the viewer's internal ms-based shape.
 * Legacy segments that packed a whole chunk into one text blob with inline
 * `[MM:SS] Speaker N:` markers are first re-split into individual turns so they
 * render correctly without re-transcription. */
export function fromStoredSegments(stored: StoredSegment[]): TranscriptSegment[] {
  return expandInlineStoredSegments(stored)
    .filter((s) => s.text?.trim())
    .map((s) => ({
      startMs: Math.round((s.start || 0) * 1000),
      endMs: s.end != null ? Math.round(s.end * 1000) : undefined,
      speaker: s.speaker,
      text: s.text.trim(),
      ...(s.speakerAttribution ? { speakerAttribution: s.speakerAttribution } : {}),
      ...(typeof s.speakerConfidence === 'number' ? { speakerConfidence: s.speakerConfidence } : {})
    }))
}

/**
 * Parse speaker name from text. Supports, at the start of the text:
 *   **Speaker Name:**   / **Speaker Name**:   / **Speaker Name**   (markdown-bold)
 *   [Speaker Name]
 *   Speaker Name:
 */
function parseSpeaker(text: string): { speaker: string | undefined; remainingText: string } {
  const trimmed = text.trimStart()

  // Markdown-bold label: **Name:** rest / **Name**: rest / **Name** rest
  // [^*\n]+? captures the name (and any inner colon); trailing colon is stripped below.
  const boldMatch = trimmed.match(/^\*\*\s*([^*\n]+?)\s*\*\*\s*:?\s*([\s\S]*)$/)
  if (boldMatch) {
    return { speaker: boldMatch[1].replace(/:\s*$/, '').trim(), remainingText: boldMatch[2].trim() }
  }

  // "[Speaker Name]" format
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]\s*([\s\S]*)$/)
  if (bracketMatch) {
    return { speaker: bracketMatch[1].trim(), remainingText: bracketMatch[2].trim() }
  }

  // "Speaker Name:" format (capitalised, no colon inside the name)
  const colonMatch = trimmed.match(/^([A-Z][^:\n]*?):\s+([\s\S]*)$/)
  if (colonMatch) {
    return { speaker: colonMatch[1].trim(), remainingText: colonMatch[2].trim() }
  }

  return { speaker: undefined, remainingText: text }
}

// A line that begins a new speaker turn (markdown-bold, bracket, or "Name:").
const SPEAKER_LINE_REGEX = /^[ \t]*(?:\*\*[^*\n]+\*\*\s*:?|\[[^\]\n]+\]|[A-Z][^:\n]{0,40}?:)\s/

/**
 * Parse a transcript with no timestamps into speaker turns. Each turn starts at
 * a line with a speaker label; continuation lines are appended to the turn.
 * Returns a single plain segment when no speaker labels are present.
 */
function parseSpeakerSegments(transcript: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  let current: TranscriptSegment | null = null

  for (const line of transcript.split('\n')) {
    if (SPEAKER_LINE_REGEX.test(line)) {
      if (current) segments.push(current)
      const { speaker, remainingText } = parseSpeaker(line)
      current = { startMs: 0, speaker, text: remainingText }
    } else if (current) {
      current.text += line.trim() ? `\n${line.trim()}` : ''
    } else if (line.trim()) {
      current = { startMs: 0, text: line.trim() }
    }
  }
  if (current) segments.push(current)

  return segments.length > 0 ? segments : [{ startMs: 0, text: transcript.trim() }]
}

/**
 * Parse timestamps from transcript text.
 * Supports formats: [MM:SS], [HH:MM:SS], MM:SS, HH:MM:SS
 */
function parseTimestamp(timestampStr: string): number | null {
  // Remove brackets if present
  const cleaned = timestampStr.replace(/[[\]]/g, '').trim()

  // Split by colons
  const parts = cleaned.split(':').map(part => parseInt(part, 10))

  if (parts.some(isNaN)) {
    return null
  }

  let totalSeconds: number

  if (parts.length === 2) {
    // MM:SS format
    const [minutes, seconds] = parts
    totalSeconds = minutes * 60 + seconds
  } else if (parts.length === 3) {
    // HH:MM:SS format
    const [hours, minutes, seconds] = parts
    totalSeconds = hours * 3600 + minutes * 60 + seconds
  } else {
    return null
  }

  return totalSeconds * 1000 // Convert to milliseconds
}

/**
 * Parse transcript into segments with timestamps.
 * Detects timestamps in formats: [MM:SS], [HH:MM:SS], bare MM:SS, HH:MM:SS at line start
 */
export function parseTranscriptSegments(transcript: string): { segments: TranscriptSegment[]; hasTimestamps: boolean } {
  const segments: TranscriptSegment[] = []

  // Timestamps at the start of a line (with optional brackets):
  // [00:15], [00:15:30], 00:15, 00:15:30. A line without one continues the turn
  // above; text before the first timestamp is its own turn at 0. Saving a
  // correction rebuilds the whole transcript from these turns, so no line may
  // be dropped here (review 28-sep-2026: continuation lines were deleted).
  const timestampLine = /^(\[?\d{1,2}:\d{2}(?::\d{2})?\]?)\s+(.*)$/
  const preamble: string[] = []
  let sawTimestamp = false

  for (const line of transcript.split(/\r?\n/)) {
    const match = timestampLine.exec(line)
    const startMs = match ? parseTimestamp(match[1]) : null
    if (match && startMs !== null) {
      sawTimestamp = true
      if (segments.length > 0) segments[segments.length - 1].endMs = startMs
      const { speaker, remainingText } = parseSpeaker(match[2].trim())
      segments.push({ startMs, text: remainingText, speaker })
      continue
    }
    const text = line.trim()
    if (!text) continue
    if (!sawTimestamp) preamble.push(text)
    else segments[segments.length - 1].text = `${segments[segments.length - 1].text}\n${text}`.trim()
  }
  if (sawTimestamp && preamble.length > 0) {
    segments.unshift({ startMs: 0, endMs: segments[0]?.startMs, text: preamble.join('\n') })
  }

  if (segments.length > 0) {
    return { segments, hasTimestamps: true }
  }

  // No timestamps — fall back to speaker-turn parsing (handles **Name:** etc.)
  return { segments: parseSpeakerSegments(transcript), hasTimestamps: false }
}

