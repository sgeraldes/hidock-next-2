import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GenerateSummaryPanel } from '../GenerateSummaryPanel'

const retrySummary = vi.fn()

beforeEach(() => {
  retrySummary.mockReset()
  window.electronAPI = { transcripts: { retrySummary } } as never
})

describe('Generate summary (28-oct-2026)', () => {
  it('writes the summary for this recording and lets the reader reload it', async () => {
    retrySummary.mockResolvedValue({ success: true, data: { written: true } })
    const onWritten = vi.fn()
    render(<GenerateSummaryPanel recordingId="rec-22" onWritten={onWritten} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate summary' }))

    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1))
    expect(retrySummary).toHaveBeenCalledWith({ recordingId: 'rec-22' })
  })

  it('says where to look when no brain could write it, and offers to try again', async () => {
    retrySummary.mockResolvedValue({ success: true, data: { written: false } })
    const onWritten = vi.fn()
    render(<GenerateSummaryPanel recordingId="rec-75" onWritten={onWritten} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate summary' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Settings > AI Brains')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(onWritten).not.toHaveBeenCalled()
  })
})
