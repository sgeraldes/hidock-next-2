import { buildSpeakerLinkingContext, type SpeakerLinkingResult } from './speaker-linking'

export function sliceContext(
  metadata: string, start: number, seconds: number,
  activity: Array<{ start: number; end: number }>, linking: SpeakerLinkingResult
): string {
  const local = <T extends { start: number; end: number }>(intervals: T[]): T[] => intervals
    .filter(s => s.end > start && s.start < start + seconds)
    .map(s => ({ ...s, start: Math.max(0, s.start - start), end: Math.min(seconds, s.end - start) }))
  const intervals = local(activity)
  const segments = local(linking.segments)
  const labels = new Set(segments.map(s => s.speaker))
  return metadata.replace(/^Duration: .* seconds$/m, `Duration: ${seconds} seconds`) + `

LOCAL AUDIO ACTIVITY EVIDENCE (authoritative safety constraint):
Non-silent audio: ${intervals.reduce((sum, s) => sum + s.end - s.start, 0)}s
Activity intervals: ${intervals.map(s => `${s.start}-${s.end}s`).join(', ')}
Do not create speaker turns outside these intervals except for up to 1.5 seconds of timestamp-boundary tolerance.

${buildSpeakerLinkingContext({ ...linking, segments, matches: linking.matches.filter(m => labels.has(m.localSpeakerLabel)) })}`
}
