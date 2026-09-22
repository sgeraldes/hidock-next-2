import type { Meeting, Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'

export type DisplayTitleSource =
  | 'meeting-subject'
  | 'user-title'
  | 'suggested'
  | 'filename'

export interface DisplayTitle {
  primaryText: string
  source: DisplayTitleSource
}

/** What the library shows on a source with no calendar event behind it. */
export type UnassignedTitlePreference = 'suggested' | 'filename'

/**
 * Title for a source in the Library and the reader.
 *
 * A calendar event's subject always wins: when a source is assigned, the
 * calendar owns its name and nothing here overrides it.
 *
 * For an UNASSIGNED source this used to return the filename, always, and said
 * so: "The immutable filename identifies an unassigned source […] User/AI
 * content titles remain independent descriptive metadata and never replace
 * either one."
 *
 * That was reversed deliberately on 2026-09-22, by the product owner, for a
 * measured reason: 945 of the 2,129 live sources have no meeting, so the library showed
 * 945 rows reading `2026Sep21-170242-Rec32.hda` while the title that actually
 * describes each one was already computed and stored a join away
 * (`knowledge_captures.title`, populated on 938 of those 945). Identity is not
 * lost: `source` tells the row the title is no longer the filename, so the row
 * hangs the filename off the second line's hover tooltip and the reader shows
 * it as an explicit Filename field. It stays searchable either way —
 * buildSearchCorpus indexes the filename independently of the title. It is NOT
 * printed as always-visible text on the row: the row's fixed 48px compact
 * height has one secondary line and it belongs to date/time/duration.
 *
 * Please do not "fix" this back to filename-only without talking to him.
 *
 * `preference` is the user's setting: `filename` restores the old order but
 * still honours a title the user typed, because that one was never a guess.
 */
export function getDisplayTitle(
  recording: UnifiedRecording,
  meeting?: Meeting,
  transcript?: Transcript,
  preference: UnassignedTitlePreference = 'suggested'
): DisplayTitle {
  void transcript
  const officialMeetingSubject = meeting?.subject?.trim() || recording.meetingSubject?.trim()
  if (officialMeetingSubject) {
    return { primaryText: officialMeetingSubject, source: 'meeting-subject' }
  }

  // A title the user typed outranks everything below it under either setting.
  const userTitle = recording.userTitle?.trim()
  if (userTitle) return { primaryText: userTitle, source: 'user-title' }

  if (preference === 'suggested') {
    const suggested = recording.title?.trim()
    if (suggested) return { primaryText: suggested, source: 'suggested' }
  }

  return { primaryText: recording.filename, source: 'filename' }
}
