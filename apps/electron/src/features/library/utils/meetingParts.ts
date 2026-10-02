import type { UnifiedRecording } from '@/types/unified-recording'

/**
 * Number the recordings that share a meeting, by start time: a meeting
 * recorded in two pieces shows "part 1 of 2" and "part 2 of 2" instead of the
 * same title twice (owner chose, 2-oct-2026). Order and untouched objects are
 * kept, so a list where nothing changed stays the same list.
 */
export function withMeetingParts(recordings: UnifiedRecording[]): UnifiedRecording[] {
  const byMeeting = new Map<string, UnifiedRecording[]>()
  for (const recording of recordings) {
    if (!recording.meetingId) continue
    const group = byMeeting.get(recording.meetingId)
    if (group) group.push(recording)
    else byMeeting.set(recording.meetingId, [recording])
  }

  const parts = new Map<string, { index: number; total: number }>()
  for (const group of byMeeting.values()) {
    if (group.length < 2) continue
    const ordered = [...group].sort((a, b) => a.dateRecorded.getTime() - b.dateRecorded.getTime())
    ordered.forEach((recording, i) => parts.set(recording.id, { index: i + 1, total: ordered.length }))
  }

  return recordings.map((recording) => {
    const part = parts.get(recording.id)
    const current = recording.meetingPart
    if (!part && !current) return recording
    if (part && current && part.index === current.index && part.total === current.total) return recording
    if (!part) {
      const { meetingPart: _stale, ...rest } = recording
      return rest as UnifiedRecording
    }
    return { ...recording, meetingPart: part }
  })
}
