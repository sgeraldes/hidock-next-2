/**
 * Inline-turn splitting for LEGACY stored transcript segments, shared by the
 * reader (which renders the turns) and the main process (which needs the same
 * turn positions: speaker overrides and splits are keyed by rendered turn).
 *
 * Transcripts produced before the parseTurns inline-marker fix (packages/
 * transcription gemini-engine) stored a whole ~10-minute chunk as ONE segment
 * whose `text` contains dozens of embedded `[MM:SS] Speaker N:` markers. This
 * re-splits such a segment into one turn per marker, so old rows display
 * correctly without re-transcription. Segments with no inline markers
 * (well-formed, post-fix data) pass through completely unchanged.
 *
 * A port of `parseInlineTurns` from the node-only @hidock/transcription package
 * (which the renderer cannot import).
 */

import type { TimingSegment } from './transcript-timing'

/** `[MM:SS] Speaker N:` (or `[HH:MM:SS] …`) turn marker, matched anywhere. */
const INLINE_TURN_RE = /\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]\s*(Speaker\s*\d+)\s*:/g

/** True when a stored line holds its own timed turns, so its start does not place them. */
export function hasInlineTurns(text: string | null | undefined): boolean {
  INLINE_TURN_RE.lastIndex = 0
  const found = INLINE_TURN_RE.test(text ?? '')
  INLINE_TURN_RE.lastIndex = 0
  return found
}

/**
 * Split one stored segment on any inline `[ts] Speaker N:` markers in its text.
 * Returns the original segment untouched (as a single-element array) when it has
 * no such markers.
 *
 * Marker times are chunk-relative. For the first chunk (segment start 0) they are
 * already absolute; for a later chunk mis-stored with relative marker times, a
 * marker time LESS than the segment's own start is offset by that start so it
 * lands at the correct absolute position. Ends are chained within the split group
 * (each turn ends where the next begins; the last inherits the original end) so
 * active-turn highlighting keeps working.
 */
export function splitOnInlineTurns<T extends TimingSegment>(segment: T): Array<T | TimingSegment> {
  const text = segment.text ?? ''
  INLINE_TURN_RE.lastIndex = 0
  const markers: Array<{ markerStart: number; contentStart: number; tsSec: number; speaker: string }> = []
  let m: RegExpExecArray | null
  while ((m = INLINE_TURN_RE.exec(text)) !== null) {
    const min = Number(m[1])
    const sec = Number(m[2])
    const tsSec = m[3] != null ? min * 3600 + sec * 60 + Number(m[3]) : min * 60 + sec
    markers.push({
      markerStart: m.index,
      contentStart: m.index + m[0].length,
      tsSec,
      speaker: m[4].replace(/\s+/g, ' ').trim()
    })
  }
  if (markers.length === 0) return [segment]

  const base = segment.start || 0
  const toAbsolute = (tsSec: number) => (tsSec < base ? base + tsSec : tsSec)
  const out: TimingSegment[] = []
  // Each turn shows or hides with the stored segment it came from. Per-line
  // review data (original times, the reviewed mark) belongs to the stored
  // segment, not to its turns, so it is not copied (Kiro review of #195).
  const marks: Partial<TimingSegment> = {
    ...(segment.timingHidden ? { timingHidden: true } : {}),
    ...(segment.sectionRunId ? { sectionRunId: segment.sectionRunId } : {}),
    ...(segment.sectionReplacedBy ? { sectionReplacedBy: segment.sectionReplacedBy } : {})
  }

  // Text before the first marker keeps the original segment's speaker/start.
  const preamble = text.slice(0, markers[0].markerStart).replace(/\s+/g, ' ').trim()
  if (preamble) {
    out.push({ ...marks, speaker: segment.speaker, start: base, text: preamble })
  }

  for (let i = 0; i < markers.length; i++) {
    const contentEnd = i + 1 < markers.length ? markers[i + 1].markerStart : text.length
    const body = text.slice(markers[i].contentStart, contentEnd).replace(/\s+/g, ' ').trim()
    if (!body) continue
    out.push({ ...marks, speaker: markers[i].speaker, start: toAbsolute(markers[i].tsSec), text: body })
  }

  if (out.length === 0) return [segment]

  // Chain ends so each turn ends where the next begins; the last inherits the
  // original segment's end (needed for the viewer's active-turn highlighting).
  for (let i = 0; i < out.length; i++) {
    const end = i + 1 < out.length ? out[i + 1].start : segment.end
    // A marker after the segment's stated end must not end before it starts.
    out[i].end = end === undefined ? undefined : Math.max(out[i].start, end)
  }
  return out
}

/**
 * How many turns the reader renders for each stored line: legacy lines split
 * into their inline turns, and turns with no text are not rendered.
 */
export function renderedTurnCounts(segments: TimingSegment[]): number[] {
  return segments.map((segment) => splitOnInlineTurns(segment).filter((turn) => turn.text?.trim()).length)
}
