import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TranscriptIntegrityPanel } from '../TranscriptIntegrityPanel'

const setIntegrityAccepted = vi.fn()

beforeEach(() => {
  setIntegrityAccepted.mockReset().mockResolvedValue({ success: true, data: { accepted: true } })
  ;(window as any).electronAPI = { transcripts: { setIntegrityAccepted } }
})

const issues = (codes: string[]) =>
  JSON.stringify({ issues: codes.map((code) => ({ code, count: 3, detail: `${code} in detail` })) })

describe('TranscriptIntegrityPanel', () => {
  it('renders nothing for a clean or unchecked transcript', () => {
    const { container, rerender } = render(
      <TranscriptIntegrityPanel recordingId="r1" transcript={{ integrity_status: 'ok', integrity_json: issues([]), integrity_accepted_at: null }} />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(<TranscriptIntegrityPanel recordingId="r1" transcript={{ integrity_status: null, integrity_json: null, integrity_accepted_at: null }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names each finding as a tag and offers both ways back to green', () => {
    const onRetranscribe = vi.fn()
    render(
      <TranscriptIntegrityPanel
        recordingId="r1"
        transcript={{ integrity_status: 'suspect', integrity_json: issues(['repeated_start', 'backwards_start']), integrity_accepted_at: null }}
        onRetranscribe={onRetranscribe}
      />
    )
    expect(screen.getByTestId('transcript-integrity')).toHaveAttribute('data-integrity', 'suspect')
    expect(screen.getByText(/The times in this transcript are wrong/)).toBeInTheDocument()
    expect(screen.getByText('Repeated times · 3')).toHaveAttribute('title', 'repeated_start in detail')
    expect(screen.getByText('Times go backwards · 3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Transcribe again/ }))
    expect(onRetranscribe).toHaveBeenCalledTimes(1)
  })

  it('says a broken transcript has text that is not in the audio', () => {
    render(
      <TranscriptIntegrityPanel recordingId="r1" transcript={{ integrity_status: 'broken', integrity_json: issues(['too_many_words']), integrity_accepted_at: null }} />
    )
    expect(screen.getByText(/more text than the recording can hold/)).toBeInTheDocument()
    expect(screen.getByText(/^Text does not fit the audio/)).toBeInTheDocument()
  })

  it('accepts as is, then reports back so the caller reloads', async () => {
    const onChanged = vi.fn()
    render(
      <TranscriptIntegrityPanel
        recordingId="r1"
        transcript={{ integrity_status: 'suspect', integrity_json: issues(['repeated_start']), integrity_accepted_at: null }}
        onChanged={onChanged}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept as is' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(setIntegrityAccepted).toHaveBeenCalledWith({ recordingId: 'r1', accepted: true })
  })

  it('shows an accepted transcript as green with an undo', async () => {
    const onChanged = vi.fn()
    render(
      <TranscriptIntegrityPanel
        recordingId="r1"
        transcript={{ integrity_status: 'suspect', integrity_json: issues(['repeated_start']), integrity_accepted_at: '2026-09-23T10:00:00.000Z' }}
        onChanged={onChanged}
      />
    )
    expect(screen.getByTestId('transcript-integrity')).toHaveAttribute('data-integrity', 'accepted')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(setIntegrityAccepted).toHaveBeenCalledWith({ recordingId: 'r1', accepted: false }))
  })

  it('shows the error when accepting fails, and does not report a change', async () => {
    setIntegrityAccepted.mockResolvedValueOnce({ success: false, error: { code: 'NOT_FOUND', message: 'This recording has no transcript' } })
    const onChanged = vi.fn()
    render(
      <TranscriptIntegrityPanel
        recordingId="r1"
        transcript={{ integrity_status: 'suspect', integrity_json: issues(['repeated_start']), integrity_accepted_at: null }}
        onChanged={onChanged}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept as is' }))
    expect(await screen.findByText('This recording has no transcript')).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
