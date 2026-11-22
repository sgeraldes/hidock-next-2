import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SpeakerReviewPanel } from '../SpeakerReviewPanel'
import type { RepairContext } from '@/shared/quality-repair'

const context = (speaker = 'Voice A'): RepairContext => ({ evidenceFingerprint: 'a'.repeat(64),
  actions: ['review_samples', 'ask_user', 'defer', 'no_action'],
  state: { confirmedFacts: { actualSpeakerCount: null }, context: { invitedCount: 2, voiceLabelCounts: { [speaker]: 3 } } },
  samples: [{ id: 'turn-3', speaker, target: { start: 30, end: 40, turnIndex: 3 },
    context: { start: 22, end: 48, turns: [{ speaker, text: 'Adjacent context' }] }, selection: 'uncertain' }] })
const api = { repairContext: vi.fn(), confirmParticipation: vi.fn(), repairAdvice: vi.fn(),
  repairSample: vi.fn(), confirmRepairSample: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks()
  api.repairContext.mockResolvedValue({ success: true, data: context() })
  api.confirmParticipation.mockResolvedValue({ success: true })
  api.repairAdvice.mockResolvedValue({ success: true, data: { action: 'review_samples', model: 'clef',
    sample: context().samples[0], confidence: { action: 0.9 } } })
  api.repairSample.mockResolvedValue({ success: true, data: { base64: 'YWJj', mimeType: 'audio/mpeg' } })
  api.confirmRepairSample.mockResolvedValue({ success: true })
  ;(window as any).electronAPI = { quality: api }
  URL.createObjectURL = vi.fn(() => 'blob:bounded-sample')
  URL.revokeObjectURL = vi.fn()
})
async function openReview() {
  const details = screen.getByText('Review speaker evidence').closest('details')!
  await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
  await screen.findByRole('button', { name: 'Save count' })
}

describe('SpeakerReviewPanel', () => {
  it('does no work until opened and does not substitute the invitation count for a confirmation', async () => {
    render(<SpeakerReviewPanel recordingId="r1" />)
    expect(api.repairContext).not.toHaveBeenCalled()
    await openReview()
    expect(screen.getByRole('spinbutton', { name: 'Confirmed people who spoke' })).toHaveValue(null)
    expect(screen.getByText(/Invitations do not establish/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save count' }))
    await waitFor(() => expect(api.confirmParticipation).toHaveBeenCalledWith('r1', 2))
    expect(await screen.findByText(/No labels were merged/)).toBeInTheDocument()
  })
  it('loads only the bounded sample and records a reply for its current evidence version', async () => {
    const rendered = render(<SpeakerReviewPanel recordingId="r1" />)
    await openReview()
    fireEvent.click(screen.getByRole('button', { name: 'Load short audio sample' }))
    await screen.findByRole('button', { name: 'Both speaking' })
    expect(api.repairSample).toHaveBeenCalledWith('r1', 'turn-3', 'a'.repeat(64))
    expect(screen.getByLabelText('Speaker sample with surrounding context')).toHaveAttribute('src', 'blob:bounded-sample')
    fireEvent.click(screen.getByRole('button', { name: 'Both speaking' }))
    await waitFor(() => expect(api.confirmRepairSample).toHaveBeenCalledWith('r1', 'turn-3', 'a'.repeat(64), 'overlap'))
    expect(await screen.findByText(/No entire voice label was reassigned/)).toBeInTheDocument()
    rendered.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bounded-sample')
  })
  it('retains the same intent after a lost evaluator response instead of redispatching a fresh request', async () => {
    api.repairAdvice.mockResolvedValue({ success: false, error: 'Outcome unknown' })
    render(<SpeakerReviewPanel recordingId="r1" />); await openReview()
    const button = screen.getByRole('button', { name: 'Recommend next check' })
    fireEvent.click(button); await screen.findByText('Outcome unknown')
    const first = api.repairAdvice.mock.calls[0][1]
    fireEvent.click(button)
    await waitFor(() => expect(api.repairAdvice).toHaveBeenCalledTimes(2))
    expect(api.repairAdvice.mock.calls[1][1]).toBe(first)
  })
  it('does not display late evidence from the previous recording', async () => {
    let resolveOld!: (value: unknown) => void
    api.repairContext.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const rendered = render(<SpeakerReviewPanel recordingId="old" />)
    const details = screen.getByText('Review speaker evidence').closest('details')!
    await act(async () => { details.open = true; fireEvent(details, new Event('toggle')) })
    rendered.rerender(<SpeakerReviewPanel recordingId="new" />)
    api.repairContext.mockResolvedValue({ success: true, data: context('New voice') })
    await openReview()
    await act(async () => resolveOld({ success: true, data: context('Old voice') }))
    expect(screen.getByRole('option', { name: /New voice/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Old voice/ })).toBeNull()
  })
})
