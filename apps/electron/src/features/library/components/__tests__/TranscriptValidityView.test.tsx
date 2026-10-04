/**
 * What the Library shows for a transcript nothing may be built on (owner,
 * 4-oct-2026): "Transcript in doubt", "Not categorized" or "Transcript
 * incomplete" where the stars would be, the reason in the transcription place,
 * a filter for each, and transcribing again with its cost.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TranscriptIntegrityPanel } from '../TranscriptIntegrityPanel'
import { ValidityLabel } from '../RowIcons'
import { transcriptProblems } from '@/features/library/utils/rowState'
import { isIntegrityFilter, integrityFilterLabel, matchesIntegrityFilter } from '@/features/library/utils/transcriptIntegrity'
import type { Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'

const setIntegrityAccepted = vi.fn()
beforeEach(() => {
  setIntegrityAccepted.mockReset().mockResolvedValue({ success: true, data: { accepted: true } })
  ;(window as any).electronAPI = { transcripts: { setIntegrityAccepted } }
})

const reasons = JSON.stringify({ status: 'doubtful', reasons: [{ code: 'no_times', detail: 'The transcript has no times.' }] })
const transcript = (over: Partial<Transcript>) =>
  ({ integrity_status: 'ok', integrity_json: null, integrity_accepted_at: null, validity_status: 'valid', validity_json: null, ...over }) as Transcript

describe('the verdict chip', () => {
  it('says what the owner asked for each verdict, and nothing for a valid transcript', () => {
    const { rerender } = render(
      <TooltipProvider>
        <ValidityLabel transcript={transcript({ validity_status: 'doubtful', validity_json: reasons })} />
      </TooltipProvider>
    )
    expect(screen.getByTestId('validity-label')).toHaveTextContent('Transcript in doubt')
    rerender(<TooltipProvider><ValidityLabel transcript={transcript({ validity_status: 'invalid' })} /></TooltipProvider>)
    expect(screen.getByTestId('validity-label')).toHaveTextContent('Not categorized')
    rerender(<TooltipProvider><ValidityLabel transcript={transcript({ validity_status: 'incomplete' })} /></TooltipProvider>)
    expect(screen.getByTestId('validity-label')).toHaveTextContent('Transcript incomplete')
    rerender(<TooltipProvider><ValidityLabel transcript={transcript({ validity_status: 'valid' })} /></TooltipProvider>)
    expect(screen.queryByTestId('validity-label')).toBeNull()
  })
})

describe('the transcription place', () => {
  const recording = { id: 'r1', transcriptionStatus: 'complete' } as UnifiedRecording
  it('puts not categorized and incomplete before a timing warning, and doubt after the audio warnings', () => {
    expect(transcriptProblems(recording, transcript({ validity_status: 'invalid' }))[0].kind).toBe('invalid')
    expect(transcriptProblems(recording, transcript({ validity_status: 'incomplete', integrity_status: 'suspect' })).map((p) => p.kind)).toEqual([
      'incomplete',
      'suspect'
    ])
    const doubt = transcriptProblems(recording, transcript({ validity_status: 'doubtful', validity_json: reasons }))
    expect(doubt).toEqual([expect.objectContaining({ kind: 'doubtful', detail: 'The transcript has no times.' })])
  })
  it('does not repeat a broken transcript as not categorized', () => {
    expect(transcriptProblems(recording, transcript({ integrity_status: 'broken', validity_status: 'invalid' })).map((p) => p.kind)).toEqual(['broken'])
  })
})

describe('the Transcript filter', () => {
  it('has one value per verdict', () => {
    expect(isIntegrityFilter('validity:doubtful')).toBe(true)
    expect(isIntegrityFilter('validity:valid')).toBe(false)
    expect(integrityFilterLabel('validity:invalid')).toBe('Not categorized')
    expect(matchesIntegrityFilter(transcript({ validity_status: 'doubtful' }), 'validity:doubtful')).toBe(true)
    expect(matchesIntegrityFilter(transcript({ validity_status: 'doubtful', integrity_accepted_at: '2026-10-04' }), 'validity:doubtful')).toBe(false)
  })
})

describe('the transcript panel', () => {
  it('explains a transcript not categorized and offers to transcribe it again with the cost', () => {
    const onRetranscribe = vi.fn()
    render(
      <TranscriptIntegrityPanel
        recordingId="r1"
        transcript={transcript({ validity_status: 'invalid', validity_json: JSON.stringify({ reasons: [{ detail: 'Most of the text sits where there is no audio.' }] }) })}
        durationSeconds={3600}
        onRetranscribe={onRetranscribe}
      />
    )
    expect(screen.getByTestId('transcript-validity')).toHaveAttribute('data-validity', 'invalid')
    expect(screen.getByText('Most of the text sits where there is no audio.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe again (about 0.20 USD)' }))
    expect(onRetranscribe).toHaveBeenCalledTimes(1)
  })

  it('leaves a transcript in doubt to the sample, and lets the owner accept it', () => {
    render(<TranscriptIntegrityPanel recordingId="r1" transcript={transcript({ validity_status: 'doubtful' })} onRetranscribe={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Transcribe again/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Accept as is' }))
    expect(setIntegrityAccepted).toHaveBeenCalledWith({ recordingId: 'r1', accepted: true })
  })
})
