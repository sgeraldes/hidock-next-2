/**
 * Transcript problems shown in place (owner, 28-sep-2026): flagged lines are
 * marked, the integrity labels jump to them, and a line's start time can be
 * corrected along with its text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TranscriptViewer } from '../TranscriptViewer'
import { TranscriptIntegrityPanel } from '../TranscriptIntegrityPanel'

vi.mock('@/components/ui/toaster', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

const noop = () => {}

// Line 3 repeats line 2's start; line 4 goes back before line 3.
const segments = [
  { speaker: 'A', start: 10, end: 12, text: 'Primera línea.' },
  { speaker: 'B', start: 20, end: 22, text: 'Segunda línea.' },
  { speaker: 'A', start: 20, end: 24, text: 'Misma hora que la anterior.' },
  { speaker: 'B', start: 15, end: 16, text: 'Vuelve atrás.' },
  { speaker: 'A', start: 30, end: 32, text: 'Normal.' }
]

function turns(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-line-issues]'))
}

describe('TranscriptViewer marks lines with problems', () => {
  it('marks exactly the lines the integrity rules flag, with a tag each', () => {
    const { container } = render(<TranscriptViewer transcript="x" segments={segments} onSeek={noop} />)
    const flagged = turns(container)
    expect(flagged.map((el) => el.getAttribute('data-line-issues'))).toEqual(['repeated_start', 'backwards_start'])
    expect(flagged[0].textContent).toContain('Misma hora que la anterior.')
    expect(screen.getByText('Repeated times')).toBeInTheDocument()
    expect(screen.getByText('Times go backwards')).toBeInTheDocument()
  })

  it('walks through the flagged lines of one kind and wraps around', () => {
    const twoRepeats = [
      ...segments.slice(0, 3),
      { speaker: 'B', start: 40, end: 41, text: 'Otra.' },
      { speaker: 'A', start: 40, end: 42, text: 'Otra repetida.' }
    ]
    const { rerender } = render(
      <TranscriptViewer transcript="x" segments={twoRepeats} onSeek={noop} issueJump={{ code: 'repeated_start', nonce: 1 }} />
    )
    expect(screen.getByTestId('transcript-turn-highlighted').textContent).toContain('Misma hora que la anterior.')
    rerender(<TranscriptViewer transcript="x" segments={twoRepeats} onSeek={noop} issueJump={{ code: 'repeated_start', nonce: 2 }} />)
    expect(screen.getByTestId('transcript-turn-highlighted').textContent).toContain('Otra repetida.')
    rerender(<TranscriptViewer transcript="x" segments={twoRepeats} onSeek={noop} issueJump={{ code: 'repeated_start', nonce: 3 }} />)
    expect(screen.getByTestId('transcript-turn-highlighted').textContent).toContain('Misma hora que la anterior.')
  })
})

describe('TranscriptViewer edits a line start time', () => {
  const mockUpdateContent = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateContent.mockImplementation(async (req: { segments: unknown[] }) => ({
      success: true,
      data: { fullText: 'x', segments: req.segments, wordCount: 1, indexedChunks: 1, ragStatus: 'indexed' }
    }))
    ;(window as any).electronAPI = {
      transcripts: {
        getSpeakerMap: vi.fn().mockResolvedValue({ success: true, data: [] }),
        updateContent: mockUpdateContent
      },
      turnSpeakers: {
        getOverrides: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getSplits: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getMergeHints: vi.fn().mockResolvedValue({ success: true, data: [] })
      },
      contacts: { getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [], total: 0 } }) }
    }
  })

  function renderEditable() {
    return render(
      <MemoryRouter>
        <TranscriptViewer transcript="x" segments={segments} recordingId="rec1" onSeek={noop} />
      </MemoryRouter>
    )
  }

  it('saves a new start when only the time changed, and moves the end with it', async () => {
    renderEditable()
    fireEvent.click(screen.getByRole('button', { name: 'Edit transcript turn 4' }))
    const time = screen.getByRole('textbox', { name: 'Start time of transcript turn 4' })
    expect(time).toHaveValue('0:15')
    fireEvent.change(time, { target: { value: '0:21.5' } })
    fireEvent.keyDown(time, { key: 'Enter' })

    await waitFor(() => expect(mockUpdateContent).toHaveBeenCalled())
    const saved = mockUpdateContent.mock.calls[0][0].segments
    expect(saved[3]).toEqual({ speaker: 'B', start: 21.5, end: 22.5, text: 'Vuelve atrás.' })
    expect(saved[2]).toEqual(segments[2])
  })

  it('refuses a time that is not a time, without saving', () => {
    renderEditable()
    fireEvent.click(screen.getByRole('button', { name: 'Edit transcript turn 2' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Start time of transcript turn 2' }), { target: { value: '1:75' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))
    expect(screen.getByRole('alert').textContent).toMatch(/1:05/)
    expect(mockUpdateContent).not.toHaveBeenCalled()
  })

  it('closes without saving when neither text nor time changed', () => {
    renderEditable()
    fireEvent.click(screen.getByRole('button', { name: 'Edit transcript turn 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))
    expect(mockUpdateContent).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Edit transcript turn 1' })).not.toBeInTheDocument()
  })
})

describe('TranscriptIntegrityPanel labels jump to the lines', () => {
  it('makes line problems buttons and leaves whole-recording problems as text', () => {
    const onJump = vi.fn()
    render(
      <TranscriptIntegrityPanel
        recordingId="rec1"
        transcript={{
          integrity_status: 'suspect',
          integrity_json: JSON.stringify({
            issues: [
              { code: 'repeated_start', count: 3, detail: '3 lines repeat a time.' },
              { code: 'past_audio_end', count: 1, detail: 'Runs past the end.' }
            ]
          }),
          integrity_accepted_at: null
        } as never}
        onJump={onJump}
      />
    )
    fireEvent.click(screen.getByTestId('integrity-jump-repeated_start'))
    expect(onJump).toHaveBeenCalledWith('repeated_start')
    expect(screen.queryByTestId('integrity-jump-past_audio_end')).not.toBeInTheDocument()
    expect(screen.getByText('Runs past the audio')).toBeInTheDocument()
  })
})
