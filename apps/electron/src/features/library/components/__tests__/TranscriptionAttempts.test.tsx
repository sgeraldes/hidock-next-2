import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TranscriptionAttempts } from '../TranscriptionAttempts'

describe('TranscriptionAttempts', () => {
  it('lists what was tried before the error, with each reason', async () => {
    const getTranscriptionAttempts = vi.fn().mockResolvedValue([
      { engine: 'configured:gemini', attempt: 1, outcome: 'failed', errorClass: 'quota', message: '429 Rate limit exceeded', startedAt: '2026-10-16T10:00:00.000Z', durationMs: 900, waitedSeconds: 0 },
      { engine: 'configured:gemini', attempt: 2, outcome: 'failed', errorClass: 'quota', message: '429 again', startedAt: '2026-10-16T10:00:41.000Z', durationMs: 800, waitedSeconds: 41 },
      { engine: 'remote:moondream/parakeet-ultra', attempt: 0, outcome: 'skipped-unavailable', errorClass: 'unavailable', message: 'The Model Host is paused', startedAt: '2026-10-16T10:00:42.000Z', durationMs: 0, waitedSeconds: 0 },
    ])
    window.electronAPI = { recordings: { getTranscriptionAttempts } } as never
    render(<TranscriptionAttempts recordingId="rec-14" />)
    await waitFor(() => expect(screen.getByText('3 attempts')).toBeInTheDocument())
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Default service (gemini): failed · 429 Rate limit exceeded')
    expect(rows[1]).toHaveTextContent('(try 2): failed after waiting 41 s')
    expect(rows[2]).toHaveTextContent('Parakeet Ultra · Photon / CUDA · Model Host: skipped, unavailable · The Model Host is paused')
    expect(getTranscriptionAttempts).toHaveBeenCalledWith('rec-14')
  })

  it('shows nothing when no attempt was recorded', async () => {
    const getTranscriptionAttempts = vi.fn().mockResolvedValue([])
    window.electronAPI = { recordings: { getTranscriptionAttempts } } as never
    const { container } = render(<TranscriptionAttempts recordingId="rec-old" />)
    await waitFor(() => expect(getTranscriptionAttempts).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
