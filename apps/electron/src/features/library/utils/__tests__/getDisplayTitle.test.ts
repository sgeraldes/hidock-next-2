import { describe, expect, it } from 'vitest'
import { getDisplayTitle } from '../getDisplayTitle'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Meeting } from '@/types'

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
  it('uses the calendar subject when the source is assigned', () => {
    expect(getDisplayTitle({ ...baseRecording, userTitle: 'Mine', title: 'AI' }, meeting)).toEqual({
      primaryText: 'Weekly delivery review',
      source: 'meeting-subject'
    })
  })

  it('then a title the user typed', () => {
    expect(getDisplayTitle({ ...baseRecording, userTitle: 'Antamina, la buena', title: 'AI' })).toEqual({
      primaryText: 'Antamina, la buena',
      source: 'user-title'
    })
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
