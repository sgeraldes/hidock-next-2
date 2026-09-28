import type { Meeting, Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import { formatSmartDate } from '@/lib/smartDate'
import { getSourceType, sourceTypeLabel } from './sourceType'

export type DisplayTitleSource =
  | 'meeting-subject'
  | 'user-title'
  | 'suggested'
  | 'date'
  | 'filename'

export interface DisplayTitle {
  primaryText: string
  source: DisplayTitleSource
}

/**
 * Title for a source in the Library and the reader.
 *
 * A calendar event's subject always wins: when a source is assigned, the
 * calendar owns its name and nothing here overrides it. Then a title the user
 * typed, then the AI-suggested title.
 *
 * With none of those, a recording is named by its kind and when it was
 * recorded ("Recording, 24 Sep 2026 11:00"), never by its file name: the owner
 * decided on 2026-09-25 that a recording's file name is historical and
 * functional (it finds the file on the device), not something to read in the
 * list. It lives in the reader's Metadata section, and search still matches it
 * (buildSearchCorpus indexes it on its own). An imported document, image or
 * note keeps its file name as the last resort: that name was chosen by a person.
 *
 * History: until 2026-09-22 unassigned sources always showed the file name;
 * that day the suggested title took over, with the file name kept in a row
 * tooltip and as an optional setting. Both are gone now.
 */
export function getDisplayTitle(
  recording: UnifiedRecording,
  meeting?: Meeting,
  transcript?: Transcript
): DisplayTitle {
  void transcript
  const officialMeetingSubject = meeting?.subject?.trim() || recording.meetingSubject?.trim()
  if (officialMeetingSubject) {
    return { primaryText: officialMeetingSubject, source: 'meeting-subject' }
  }

  const userTitle = recording.userTitle?.trim()
  if (userTitle) return { primaryText: userTitle, source: 'user-title' }

  const suggested = recording.title?.trim()
  if (suggested) return { primaryText: suggested, source: 'suggested' }

  if (getSourceType(recording) !== 'audio' && recording.filename?.trim()) {
    return { primaryText: recording.filename, source: 'filename' }
  }
  return { primaryText: dateTitle(recording), source: 'date' }
}

function dateTitle(recording: UnifiedRecording): string {
  const type = getSourceType(recording)
  const kind = type === 'audio' ? 'Recording' : sourceTypeLabel(type)
  const when = formatSmartDate(recording.dateRecorded, { time: true, fallback: '' })
  return when ? `${kind}, ${when}` : kind
}
