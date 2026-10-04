import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReferenceLabels } from '../pipeline/ReferenceLabels'
import type { ReferenceLabelSet, RecordingKind } from '@/shared/decision-labels'

let answers: Record<string, RecordingKind | null>
const getLabelSet = vi.fn(async (): Promise<ReferenceLabelSet> => ({
  id: 'set', question: 'kind', createdAt: '2026-10-04',
  counts: { doubtful: 1, confident: 2 }, labeled: Object.values(answers).filter(Boolean).length,
  items: ['a', 'b', 'c'].map((recordingId, position) => ({ recordingId, position, answer: answers[recordingId] ?? null }))
}))
const getLabelItem = vi.fn(async ({ recordingId }: { recordingId: string }) => ({
  recordingId, date: '2026-10-04T12:00:00Z', durationSeconds: 120,
  meetingSubject: 'Planning', excerpt: `Opening ${recordingId}`, answer: answers[recordingId] ?? null
}))
const saveLabel = vi.fn(async ({ recordingId, answer }: { recordingId: string; answer: RecordingKind }) => { answers[recordingId] = answer })
const clearLabel = vi.fn(async ({ recordingId }: { recordingId: string }) => { answers[recordingId] = null })
beforeEach(() => {
  vi.clearAllMocks()
  answers = {}
  window.electronAPI = { pipeline: { getLabelSet, getLabelItem, saveLabel, clearLabel } } as never
})
describe('Reference labels', () => {
  it('picks, advances, counts, skips, goes back, changes and clears', async () => {
    render(<ReferenceLabels />)
    expect(await screen.findByText('Opening a')).toBeInTheDocument()
    expect(screen.getByText('0 of 3 labeled')).toBeInTheDocument()
    expect(screen.getByText(/Only 1 doubtful and 2 confident/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Interview/ }))
    expect(await screen.findByText('Opening b')).toBeInTheDocument()
    expect(screen.getByText('1 of 3 labeled')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(await screen.findByText('Opening c')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Opening b')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Opening a')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Interview/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Team meeting/ }))
    await screen.findByText('Opening b')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByText('Opening a')
    expect(screen.getByRole('button', { name: /Team meeting/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Clear label' }))
    await waitFor(() => expect(screen.getByText('0 of 3 labeled')).toBeInTheDocument())
    expect(saveLabel).toHaveBeenCalledTimes(2)
  })
  it('number shortcuts pick a kind and ignore modified or repeated keys', async () => {
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    fireEvent.keyDown(window, { key: '2', ctrlKey: true })
    fireEvent.keyDown(window, { key: '2', repeat: true })
    expect(saveLabel).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '2' })
    await screen.findByText('Opening b')
    expect(saveLabel).toHaveBeenCalledWith({ setId: 'set', recordingId: 'a', answer: 'team_meeting' })
  })
  it('shows completion after the last item and permits going back', async () => {
    render(<ReferenceLabels />)
    for (const id of ['a', 'b', 'c']) {
      await screen.findByText(`Opening ${id}`)
      fireEvent.click(screen.getByRole('button', { name: /Interview/ }))
    }
    expect(await screen.findByText('3 of 3 labeled')).toBeInTheDocument()
    expect(screen.getByText('You have reached the end of this set.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Opening c')).toBeInTheDocument()
  })
  it('keeps the current item and progress when a save fails', async () => {
    saveLabel.mockRejectedValueOnce(new Error('Disk unavailable'))
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    fireEvent.click(screen.getByRole('button', { name: /Interview/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk unavailable')
    expect(screen.getByText('Opening a')).toBeInTheDocument()
    expect(screen.getByText('0 of 3 labeled')).toBeInTheDocument()
  })
})
