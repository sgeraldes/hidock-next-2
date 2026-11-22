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
    // A meeting recorded in pieces names each piece (owner chose, 2-oct-2026).
    const part = recording.meetingPart && recording.meetingPart.total > 1
      ? ` · part ${recording.meetingPart.index} of ${recording.meetingPart.total}`
      : ''
    return { primaryText: `${officialMeetingSubject}${part}`, source: 'meeting-subject' }
  }

  if (getSourceType(recording) === 'link') {
    const title = (recording.userTitle?.trim() || recording.title?.trim() || recording.filename).replace(/\.url$/i, '')
      .replace(/^([^·]+) · ([CDG][A-Z0-9]+) · thread [\d.]+$/, 'Slack · $1 · #$2 · thread')
      .replace(/^[\w.-]+\.atlassian\.net · ([A-Z][A-Z0-9_]*-\d+)$/, 'Jira · $1')
    return { primaryText: title, source: 'user-title' }
  }
  if (recording.parentVideoCaptureId && recording.videoAudioTitle) {
    return { primaryText: recording.userTitle?.trim() || recording.videoAudioTitle, source: 'user-title' }
  }
  const userTitle = realTitle(recording.userTitle, recording.filename)
  if (userTitle) return { primaryText: userTitle, source: 'user-title' }

  const suggested = realTitle(recording.title, recording.filename)
  if (suggested) return { primaryText: suggested, source: 'suggested' }

  if (getSourceType(recording) !== 'audio' && recording.filename?.trim()) {
    return { primaryText: recording.filename, source: 'filename' }
  }
  return { primaryText: dateTitle(recording), source: 'date' }
}

/** The file name without its extension, lower case: "2026sep24-110051-rec52". */
function fileStem(name: string): string {
  return name.trim().replace(/\.[a-z0-9]{2,4}$/i, '').toLowerCase()
}

/**
 * A stored title, or undefined when it is empty or only the file name. A
 * recording with no speech gets no suggestion, and its knowledge capture stores
 * the file name as its title (the column cannot be empty); 14 of them reached
 * the list on 2-oct-2026.
 */
function realTitle(value: string | undefined, filename: string | undefined): string | undefined {
  const title = value?.trim()
  if (!title) return undefined
  if (filename?.trim() && fileStem(title) === fileStem(filename)) return undefined
  return title
}

function dateTitle(recording: UnifiedRecording): string {
  const type = getSourceType(recording)
  const kind = type === 'audio' ? 'Recording' : sourceTypeLabel(type)
  const when = formatSmartDate(recording.dateRecorded, { time: true, fallback: '' })
  return when ? `${kind}, ${when}` : kind
}
