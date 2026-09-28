import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceRow } from '../SourceRow'
import type { UnifiedRecording } from '@/types/unified-recording'
import {
  effectiveWarning,
  matchesKindFilter,
  matchesStarsFilter,
  matchesWarningFilter,
  isStarsFilter
} from '@/features/library/utils/evaluation'

const base: UnifiedRecording = {
  id: 'r1',
  filename: '2026Sep24-101500-Rec12.wav',
  title: 'Weekly sync',
  dateRecorded: new Date('2026-09-24T10:15:00'),
  duration: 1800,
  size: 14_000_000,
  location: 'local-only',
  syncStatus: 'synced',
  localPath: '/tmp/rec.wav',
  transcriptionStatus: 'complete',
  knowledgeCaptureId: 'cap-1'
}

const SLOT_ORDER = ['labels', 'value', 'warning', 'integrity', 'meeting', 'status', 'transcription', 'error']

function slotNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot]')).map((el) => el.getAttribute('data-slot') ?? '')
}

describe('Jev evaluation on a Library row', () => {
  it('shows stars and kind as one label', () => {
    render(<SourceRow recording={{ ...base, evalStarLevel: 4, evalKind: 'team_meeting', evalContext: 'work' }} />)
    const label = screen.getByTestId('evaluation-label')
    expect(label).toHaveTextContent('4★')
    expect(label).toHaveTextContent('Team meeting')
    expect(label).toHaveAttribute('aria-label', '4 of 5 stars, Team meeting, Work')
  })

  it('shows the audio-versus-transcript warning as an icon with its words for screen readers', () => {
    render(<SourceRow recording={{ ...base, evalStarLevel: 4, evalAudioWarning: 'possible_invented_transcript' }} />)
    expect(screen.getByTestId('evaluation-warning')).toHaveAttribute('aria-label', 'Transcript may be invented')
  })

  it('shows nothing for a recording not evaluated yet', () => {
    render(<SourceRow recording={base} />)
    expect(screen.queryByTestId('evaluation-label')).toBeNull()
    expect(screen.queryByTestId('evaluation-warning')).toBeNull()
  })

  it('updates when an evaluation arrives (the row is memoized)', () => {
    const { rerender } = render(<SourceRow recording={base} />)
    rerender(<SourceRow recording={{ ...base, evalStarLevel: 2, evalKind: 'device_test' }} />)
    expect(screen.getByTestId('evaluation-label')).toHaveTextContent('Device test')
  })
})

describe('fixed icon places on a Library row', () => {
  it('renders every place in the same order, labels first, whether or not it has an icon', () => {
    const empty = render(<SourceRow recording={base} />)
    expect(slotNames(empty.container)).toEqual(SLOT_ORDER)
    empty.unmount()
    const full = render(
      <SourceRow
        recording={{ ...base, quality: 'garbage', evalStarLevel: 1, evalKind: 'noise_accidental', evalAudioWarning: 'possible_invented_transcript', audioCategory: 'silent' }}
      />
    )
    expect(slotNames(full.container)).toEqual(SLOT_ORDER)
  })

  it('keeps an empty place instead of closing the gap', () => {
    const { container } = render(<SourceRow recording={base} />)
    const value = container.querySelector('[data-slot="value"]')
    expect(value).not.toBeNull()
    expect(value?.childElementCount).toBe(0)
    expect(value?.className).toContain('w-4')
  })
})

describe('evaluation filters', () => {
  it('stars filters cover single levels and the two ranges', () => {
    expect(matchesStarsFilter({ evalStarLevel: 5 }, '4plus')).toBe(true)
    expect(matchesStarsFilter({ evalStarLevel: 3 }, '4plus')).toBe(false)
    expect(matchesStarsFilter({ evalStarLevel: 2 }, '2minus')).toBe(true)
    expect(matchesStarsFilter({ evalStarLevel: 3 }, '3')).toBe(true)
    expect(matchesStarsFilter({}, '2minus')).toBe(false)
    expect(isStarsFilter('4plus')).toBe(true)
    expect(isStarsFilter('6')).toBe(false)
  })

  it('"Not evaluated yet" finds recordings without a kind', () => {
    expect(matchesKindFilter({}, 'unevaluated')).toBe(true)
    expect(matchesKindFilter({ evalKind: 'interview' }, 'unevaluated')).toBe(false)
    expect(matchesKindFilter({ evalKind: 'interview' }, 'interview')).toBe(true)
  })

  it('a sure "invented" answer from Jev counts as a warning even when the audio rule did not fire', () => {
    expect(effectiveWarning({ evalTranscriptInvented: 0.9 })).toBe('possible_invented_transcript')
    expect(effectiveWarning({ evalTranscriptInvented: 0.5 })).toBeNull()
    expect(matchesWarningFilter({ evalAudioWarning: 'possible_missed_transcription' }, 'any')).toBe(true)
    expect(matchesWarningFilter({ evalAudioWarning: 'possible_missed_transcription' }, 'possible_invented_transcript')).toBe(false)
  })
})
