import type { UnifiedRecording } from '@/types/unified-recording'

/**
 * Remove cached display-part metadata that was previously inferred from a
 * calendar meeting link. UnifiedRecording has no capture-group lineage, and
 * separate calls can share one meetingId. Persisted split filenames and user
 * titles remain untouched.
 */
export function withMeetingParts(recordings: UnifiedRecording[]): UnifiedRecording[] {
  let changed = false
  const withoutCachedParts = recordings.map((recording) => {
    if (!recording.meetingPart) return recording
    changed = true
    const { meetingPart: _cachedPart, ...preserved } = recording
    return preserved as UnifiedRecording
  })
  return changed ? withoutCachedParts : recordings
}
