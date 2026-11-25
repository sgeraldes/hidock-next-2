import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TranscriptTimingReview, useTranscriptTimingReview } from '../TranscriptTimingReview'
import type { TimingAssessment, TimingFinding } from '@/shared/transcript-timing'

// Rec28's two cases, as the main process reports them.
const odd: TimingFinding = {
  id: 'odd_line:0-0', kind: 'odd_line', index: 0, from: 0, to: 0, lines: [0], claimedStart: 494.8, claimedEnd: 505.7,
  windowStart: 0, windowEnd: 13, impliedStart: 4.86, suggestedStart: 4.86, classification: 'out_of_place',
  claimedAudio: true, impliedAudio: true, detail: 'This line says 8:15, but the lines around it place it between 0:00 and 0:13.',
  fix: { ok: true, confidence: 1, firstStart: 4.86, reason: '', offerSection: false, displacement: 481.8 }
}
const run: TimingFinding = {
  id: 'mistimed_run:195-196', kind: 'mistimed_run', index: 195, from: 195, to: 196, lines: [195, 196], claimedStart: 3351, claimedEnd: 3360.7,
  windowStart: 3359.7, windowEnd: 3360.7, impliedStart: null, suggestedStart: null, classification: 'unsure',
  claimedAudio: true, impliedAudio: true, detail: 'These 2 lines may be out of place.',
  fix: { ok: false, confidence: 0.1, firstStart: null, reason: 'These lines have more words than 1.0 s of speech can hold.', offerSection: true, displacement: 8.7 }
}
const duplicate: TimingFinding = {
  id: 'duplicate:195-195', kind: 'duplicate', index: 195, from: 195, to: 195, lines: [195], originals: [193], claimedStart: 3351, claimedEnd: 3351.8,
  windowStart: null, windowEnd: null, impliedStart: null, suggestedStart: null, classification: 'duplicate',
  claimedAudio: null, impliedAudio: null, detail: 'This line repeats what the line at 55:59 already says.'
}
const assessment = (patch: Partial<TimingAssessment> = {}): TimingAssessment => ({
  fingerprint: 'f'.repeat(40), findings: [odd, run, duplicate], hiddenIndices: [], fixedRanges: [], sectionRuns: [],
  reviewed: false, evidence: 'vad', ...patch
})
const segments = Array.from({ length: 200 }, (_, i) => ({ start: i, end: i + 0.5, text: `line ${i}` }))

const reviewTiming = vi.fn()
const retranscribeSection = vi.fn()
const getTiming = vi.fn()

function Harness({ onJump = vi.fn(), onUpdated = vi.fn(), recordingId = 'rec-28' }: { onJump?: (i: number) => void; onUpdated?: () => void; recordingId?: string }) {
  const review = useTranscriptTimingReview(recordingId, 'rev-1')
  return <TranscriptTimingReview recordingId={recordingId} segments={segments} review={review} onJump={onJump} onUpdated={onUpdated} />
}

beforeEach(() => {
  vi.clearAllMocks()
  getTiming.mockResolvedValue({ success: true, data: assessment() })
  Object.assign(window, { electronAPI: { transcripts: { getTiming, reviewTiming, retranscribeSection } } })
})

describe('TranscriptTimingReview: the warning at the top of the transcript', () => {
  it('shows one chip per problem, and each chip goes to its line', async () => {
    const onJump = vi.fn()
    render(<Harness onJump={onJump} />)
    expect(await screen.findByText('3 timing problems')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Line out of order · 8:14' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Section out of order · 55:51 · 2 lines' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Written twice · 55:51' }))
    expect(onJump).toHaveBeenCalledWith(195)
    fireEvent.click(screen.getByRole('button', { name: 'Go to the first copy' }))
    expect(onJump).toHaveBeenLastCalledWith(193)
    // Going to the first copy keeps the duplicate open, so Hide the copy is still there.
    expect(screen.getByRole('button', { name: 'Hide the copy' })).toBeInTheDocument()
  })

  it('Fix times sends the finding, and the update goes back to the reader', async () => {
    const onUpdated = vi.fn()
    reviewTiming.mockResolvedValue({ success: true, data: { fullText: 'x', segments: [], wordCount: 1 } })
    render(<Harness onUpdated={onUpdated} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fix times (from 0:04.9)' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
    expect(reviewTiming).toHaveBeenCalledWith({ recordingId: 'rec-28', fingerprint: 'f'.repeat(40), action: 'fix_times', findingId: 'odd_line:0-0' })
    expect(retranscribeSection).not.toHaveBeenCalled()
  })

  it('offers a section transcription only when the sound cannot place the lines, and only sends after a confirmation', async () => {
    retranscribeSection.mockResolvedValue({ success: true, data: { fullText: 'x', segments: [], wordCount: 1 } })
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: 'Section out of order · 55:51 · 2 lines' }))
    expect(screen.queryByRole('button', { name: /Fix times/ })).not.toBeInTheDocument()
    expect(screen.getByText(/more words than 1.0 s of speech/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe this section again' }))
    expect(retranscribeSection).not.toHaveBeenCalled()
    expect(screen.getByTestId('section-retranscribe-confirm')).toHaveTextContent(/to Gemini to transcribe again/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('section-retranscribe-confirm')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe this section again' }))
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }))
    await waitFor(() => expect(retranscribeSection).toHaveBeenCalledTimes(1))
    expect(retranscribeSection).toHaveBeenCalledWith({ recordingId: 'rec-28', fingerprint: 'f'.repeat(40), findingId: 'mistimed_run:195-196' })
  })

  it('turns a refused fix into the section offer, with the reason', async () => {
    reviewTiming.mockResolvedValue({ success: false, error: { message: 'The words and the speech do not match well enough.', details: { lowConfidence: true } } })
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fix times (from 0:04.9)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match well enough')
    expect(screen.getByRole('button', { name: 'Transcribe this section again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Fix times/ })).not.toBeInTheDocument()
  })

  it('does not offer a paid section transcription for lines a second off (two people talking at once)', async () => {
    const overlap = { ...run, id: 'mistimed_run:10-11', from: 10, to: 11, lines: [10, 11],
      fix: { ok: false, confidence: 0, firstStart: null, reason: 'They start 0.8 s from where the lines around them say.', offerSection: false, displacement: 0.8 } }
    getTiming.mockResolvedValue({ success: true, data: assessment({ findings: [overlap] }) })
    render(<Harness />)
    expect(await screen.findByText(/0.8 s from where/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Transcribe this section again' })).not.toBeInTheDocument()
  })

  it('Hide the copy hides the duplicate; fixed times and section transcriptions can be undone', async () => {
    getTiming.mockResolvedValue({ success: true, data: assessment({
      findings: [duplicate], fixedRanges: [{ from: 0, to: 0 }], sectionRuns: [{ runId: 'run-9', from: 197, to: 198 }]
    }) })
    reviewTiming.mockResolvedValue({ success: true, data: { fullText: 'x', segments: [], wordCount: 1 } })
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide the copy' }))
    await waitFor(() => expect(reviewTiming).toHaveBeenCalledWith(expect.objectContaining({ action: 'hide', findingId: 'duplicate:195-195' })))
    expect(screen.getByText('Times fixed on line 1.')).toBeInTheDocument()
    expect(screen.getByText('Section transcribed again: lines 198 to 199.')).toBeInTheDocument()
    const undo = screen.getAllByRole('button', { name: 'Undo' })
    fireEvent.click(undo[0])
    await waitFor(() => expect(reviewTiming).toHaveBeenCalledWith(expect.objectContaining({ action: 'undo_fix', range: { from: 0, to: 0 } })))
    fireEvent.click(undo[1])
    await waitFor(() => expect(reviewTiming).toHaveBeenCalledWith(expect.objectContaining({ action: 'undo_section', runId: 'run-9' })))
  })

  it('drops a save that finishes after the owner opened another recording (CodeRabbit review of #195)', async () => {
    const onUpdated = vi.fn()
    let finish: (value: unknown) => void = () => {}
    reviewTiming.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { rerender } = render(<Harness onUpdated={onUpdated} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fix times (from 0:04.9)' }))
    rerender(<Harness onUpdated={onUpdated} recordingId="rec-other" />)
    finish({ success: true, data: { fullText: 'x', segments: [], wordCount: 1 } })
    await waitFor(() => expect(getTiming).toHaveBeenCalledWith({ recordingId: 'rec-other' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onUpdated).not.toHaveBeenCalled()
  })
})
