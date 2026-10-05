import { describe, expect, it } from 'vitest'
import { getDisplayTitle } from '../getDisplayTitle'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Meeting, Transcript } from '@/types'

const baseRecording: UnifiedRecording = {
  id: 'rec-1',
  filename: '2026Sep24-110051-Rec52.hda',
  size: 1024,
  duration: 60,
  dateRecorded: new Date('2026-09-24T14:00:51Z'),
  transcriptionStatus: 'none',
  location: 'local-only',
  localPath: '/path/to/rec.wav',
  syncStatus: 'synced'
}

const meeting = { id: 'm-1', subject: 'Weekly delivery review' } as Meeting

describe('getDisplayTitle', () => {
  it('restores transcript suggestions for doubtful and gap-only recordings while withholding density and invalid titles', () => {
    for (const validity_status of ['doubtful', 'incomplete']) {
      const transcript = { validity_status, validity_json: '{"reasons":[{"code":"sparse_long_segment"}]}', title_suggestion: 'Retained meeting title' } as Transcript
      expect(getDisplayTitle(baseRecording, undefined, transcript).primaryText).toBe('Retained meeting title')
    }
    for (const validity_status of ['invalid', 'incomplete']) {
      const transcript = { validity_status, validity_json: '{"reasons":[{"code":"sparse_speech"}]}', title_suggestion: 'Withheld title' } as Transcript
      expect(getDisplayTitle({ ...baseRecording, title: 'Machine title' }, undefined, transcript).source).toBe('date')
      expect(getDisplayTitle({ ...baseRecording, userTitle: 'Owner title' }, undefined, transcript).primaryText).toBe('Owner title')
    }
  })
  it('never displays a link filename extension, including a title equal to its file stem', () => {
    for (const userTitle of [undefined, 'Example', 'Example.url']) {
      expect(getDisplayTitle({ ...baseRecording, filename: 'Example.url', userTitle }).primaryText).toBe('Example')
    }
  })
  it('formats legacy Slack and Jira link identities without rewriting stored filenames', () => {
    expect(getDisplayTitle({ ...baseRecording, filename: 'team · C123 · thread 1234567890.123456.url' }).primaryText).toBe('Slack · team · #C123 · thread')
    expect(getDisplayTitle({ ...baseRecording, filename: 'team.atlassian.net · ABC-123.url' }).primaryText).toBe('Jira · ABC-123')
  })
  it('uses the linked video audio title while keeping an explicit rename', () => {
    const audio = { ...baseRecording, parentVideoCaptureId: 'video', videoAudioTitle: 'r2-video.mp4 · audio' }
    expect(getDisplayTitle(audio).primaryText).toBe('r2-video.mp4 · audio')
    expect(getDisplayTitle({ ...audio, userTitle: 'My audio' }).primaryText).toBe('My audio')
  })
  it('uses the calendar subject when the source is assigned', () => {
    expect(getDisplayTitle({ ...baseRecording, userTitle: 'Mine', title: 'AI' }, meeting)).toEqual({
      primaryText: 'Weekly delivery review',
      source: 'meeting-subject'
    })
  })

  it('numbers the parts of a meeting recorded in pieces (owner chose, 2-oct-2026)', () => {
    expect(getDisplayTitle({ ...baseRecording, meetingPart: { index: 1, total: 2 } }, meeting).primaryText).toBe(
      'Weekly delivery review · part 1 of 2'
    )
    // A title the user typed is theirs: no number added.
    expect(
      getDisplayTitle({ ...baseRecording, userTitle: 'Mine', meetingPart: { index: 2, total: 2 } }).primaryText
    ).toBe('Mine')
  })

  it('then a title the user typed', () => {
    expect(getDisplayTitle({ ...baseRecording, userTitle: 'Antamina, la buena', title: 'AI' })).toEqual({
      primaryText: 'Antamina, la buena',
      source: 'user-title'
    })
  })

  it('treats a stored title that is only the file name as no title (owner, 2-oct-2026)', () => {
    // A recording with no speech gets no suggestion, and its capture stores the file name instead.
    for (const stored of ['2026Sep24-110051-Rec52.hda', '2026sep24-110051-rec52', '2026Sep24-110051-Rec52.wav', ' 2026Sep24-110051-Rec52.hda ']) {
      const title = getDisplayTitle({ ...baseRecording, title: stored })
      expect(title.source, stored).toBe('date')
      expect(title.primaryText).toMatch(/^Recording, /)
    }
    expect(getDisplayTitle({ ...baseRecording, userTitle: '2026Sep24-110051-Rec52.hda' }).source).toBe('date')
  })

  it('then the suggested title', () => {
    expect(getDisplayTitle({ ...baseRecording, title: 'Budget review with Laura' })).toEqual({
      primaryText: 'Budget review with Laura',
      source: 'suggested'
    })
  })

  it('never the file name: with nothing else, the kind and the date', () => {
    // Sebastián, 25-sep-2026: the file name is for finding the file on the
    // device; it belongs in the reader's Metadata, not in the list.
    const result = getDisplayTitle({ ...baseRecording, userTitle: '   ', title: '  ' })
    expect(result.source).toBe('date')
    expect(result.primaryText).not.toContain('Rec52')
    expect(result.primaryText).not.toContain('.hda')
    expect(result.primaryText).toMatch(/2026/)
  })

  it('names an undated source by its kind alone', () => {
    const result = getDisplayTitle({ ...baseRecording, dateRecorded: new Date('invalid') })
    expect(result.source).toBe('date')
    expect(result.primaryText).not.toContain('Unknown')
    expect(result.primaryText).not.toContain('Rec52')
  })
})
