import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceRow } from '../SourceRow'
import type { UnifiedRecording } from '@/types/unified-recording'
import { matchesAudioFilter } from '@/features/library/utils/audioCheck'

const base: UnifiedRecording = {
  id: 'r1',
  filename: '2026Jul14-135319-Rec56.wav',
  title: 'Engineering + HR meeting',
  dateRecorded: new Date('2026-07-14T13:53:19'),
  duration: 20,
  size: 159564,
  location: 'local-only',
  syncStatus: 'synced',
  localPath: '/tmp/rec.wav',
  transcriptionStatus: 'complete',
  knowledgeCaptureId: 'cap-1'
}

describe('audio check label on a Library row', () => {
  it.each([
    ['silent', 'Silent'],
    ['noise', 'Noise only'],
    ['too_short', 'Too short'],
  ] as const)('shows "%s" as the word %s', (category, word) => {
    render(<SourceRow recording={{ ...base, audioCategory: category }} />)
    expect(screen.getByTestId('audio-label')).toHaveTextContent(word)
  })

  it('shows nothing for speech or for a recording not checked yet', () => {
    const { rerender } = render(<SourceRow recording={{ ...base, audioCategory: 'speech' }} />)
    expect(screen.queryByTestId('audio-label')).toBeNull()
    rerender(<SourceRow recording={{ ...base, audioCategory: undefined }} />)
    expect(screen.queryByTestId('audio-label')).toBeNull()
  })

  it('updates when the check finishes (the row is memoized)', () => {
    const { rerender } = render(<SourceRow recording={{ ...base }} />)
    expect(screen.queryByTestId('audio-label')).toBeNull()
    rerender(<SourceRow recording={{ ...base, audioCategory: 'silent' }} />)
    expect(screen.getByTestId('audio-label')).toHaveTextContent('Silent')
  })
})

describe('audio filter', () => {
  it('"No usable sound" covers silent, noise only and too short', () => {
    expect(['silent', 'noise', 'too_short'].every((c) => matchesAudioFilter(c as never, 'no_sound'))).toBe(true)
    expect(matchesAudioFilter('speech', 'no_sound')).toBe(false)
    expect(matchesAudioFilter(undefined, 'no_sound')).toBe(false)
  })

  it('"Not checked yet" finds recordings without a category', () => {
    expect(matchesAudioFilter(undefined, 'unchecked')).toBe(true)
    expect(matchesAudioFilter('speech', 'unchecked')).toBe(false)
  })
})
