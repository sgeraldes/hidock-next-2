import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceRow } from '../SourceRow'
import { useLibraryStore } from '@/store/useLibraryStore'
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

// Three icon places after the chips. A processing error takes the place of the status icon and a
// transcript warning takes the place of the transcription icon, so neither has a place of its own
// (owner, 30-sep-2026).
const SLOT_ORDER = ['labels', 'meeting', 'status', 'transcription']

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
    expect(screen.getByTestId('transcript-problem')).toHaveAttribute('aria-label', 'Transcript may be invented')
  })

  it('shows nothing for a recording not evaluated yet', () => {
    render(<SourceRow recording={base} />)
    expect(screen.queryByTestId('evaluation-label')).toBeNull()
    expect(screen.queryByTestId('transcript-problem')).toBeNull()
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
    const meeting = container.querySelector('[data-slot="meeting"]')
    expect(meeting).not.toBeNull()
    expect(meeting?.childElementCount).toBe(0)
    expect(meeting?.className).toContain('w-4')
  })
})

describe('a problem takes the place of what it is a problem with', () => {
  const slot = (container: HTMLElement, name: string) => container.querySelector(`[data-slot="${name}"]`) as HTMLElement

  it('a transcript warning replaces the transcription state, and the tooltip still says the state', () => {
    const { container } = render(
      <SourceRow recording={{ ...base, evalAudioWarning: 'possible_missed_transcription' }} />
    )
    const transcription = slot(container, 'transcription')
    expect(transcription.querySelector('[data-testid="transcript-problem"]')).not.toBeNull()
    expect(transcription.querySelector('[aria-label="Transcribed"]')).toBeNull()
    expect(transcription.querySelectorAll('svg')).toHaveLength(1)
  })

  it('a transcript that does not fit the audio shows the worst problem, in red', () => {
    const transcript = {
      id: 't1',
      integrity_status: 'broken',
      integrity_json: JSON.stringify([{ code: 'too_long_for_audio', detail: 'x' }])
    } as never
    const { container } = render(
      <SourceRow recording={{ ...base, evalAudioWarning: 'possible_invented_transcript' }} transcript={transcript} />
    )
    const icon = slot(container, 'transcription').querySelector('[data-testid="transcript-problem"]')
    expect(icon?.getAttribute('data-kind')).toBe('broken')
    expect(icon?.className).toContain('text-red-600')
    expect(icon?.getAttribute('aria-label')).toContain('Transcript may be invented')
  })

  it('a run in flight or a failed run keeps saying so instead of a problem with the old transcript', () => {
    for (const status of ['pending', 'processing', 'error'] as const) {
      const { container, unmount } = render(
        <SourceRow recording={{ ...base, transcriptionStatus: status, evalAudioWarning: 'possible_invented_transcript' }} />
      )
      expect(slot(container, 'transcription').querySelector('[data-testid="transcript-problem"]'), status).toBeNull()
      unmount()
    }
  })

  it('a processing error replaces the location icon in the status place', () => {
    useLibraryStore.getState().setRecordingError('r1', {
      type: 'transcription_failed',
      message: 'The provider refused the file',
      recoverable: true
    } as never)
    try {
      const { container } = render(<SourceRow recording={{ ...base, location: 'both', deviceFilename: 'x.hda' }} />)
      const status = slot(container, 'status')
      expect(status.querySelector('[data-testid="processing-error"]')).not.toBeNull()
      expect(status.querySelector('[aria-label="Synced"]')).toBeNull()
      expect(status.querySelectorAll('svg')).toHaveLength(1)
    } finally {
      useLibraryStore.getState().clearRecordingError('r1')
    }
  })

  it('without an error the status place shows where the file is', () => {
    const { container } = render(<SourceRow recording={{ ...base, location: 'both', deviceFilename: 'x.hda' }} />)
    expect(slot(container, 'status').querySelector('[aria-label="Synced"]')).not.toBeNull()
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

  // Owner, 4-oct-2026: an LLM cannot tell invented text, so only the
  // audio-against-text rule warns.
  it('warns only from the stored audio rule', () => {
    expect(effectiveWarning({})).toBeNull()
    expect(effectiveWarning({ evalAudioWarning: 'possible_invented_transcript' })).toBe('possible_invented_transcript')
    expect(matchesWarningFilter({ evalAudioWarning: 'possible_missed_transcription' }, 'any')).toBe(true)
    expect(matchesWarningFilter({ evalAudioWarning: 'possible_missed_transcription' }, 'possible_invented_transcript')).toBe(false)
  })
})
