import { create } from 'zustand'
import { lineIssues, type LineIssueCode, type TimedLine } from '@/shared/transcript-line-issues'

interface SegmentJump {
  recordingId: string
  index?: number
  code?: LineIssueCode
  nonce: number
}
/** Reader layout changes can remount SourceReader. Keep only the pending target,
 * never transcript text, outside that component; also usable by transcript find.
 */
export const useTranscriptSegmentNavigation = create<{
  request: SegmentJump | null
  jump: (target: Omit<SegmentJump, 'nonce'>) => void
}>((set, get) => ({
  request: null,
  jump: target => set({ request: { ...target, nonce: (get().request?.nonce ?? 0) + 1 } })
}))

export type ReaderTimingIssue = LineIssueCode | 'past_audio_end'

/** A whole-transcript past-end finding points to the line defining that end.
 * Keep its existing count of one, rather than flagging every later line.
 */
export function readerTimingIssueLines(lines: TimedLine[], pastAudioEnd = false): ReaderTimingIssue[][] {
  const issues: ReaderTimingIssue[][] = lineIssues(lines)
  if (!pastAudioEnd) return issues
  let last = -1
  let time = -Infinity
  lines.forEach((line, index) => {
    if (line.timingHidden || line.start === null) return
    const end = Math.max(line.start, line.end ?? line.start)
    if (end >= time) { time = end; last = index }
  })
  if (last >= 0) issues[last].push('past_audio_end')
  return issues
}
