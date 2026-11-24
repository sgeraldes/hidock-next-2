import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptViewer } from '../TranscriptViewer'

const scrollToIndex = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: () => ({
  getVirtualItems: () => [{ index: 0, start: 0 }, { index: 1, start: 100 }],
  getTotalSize: () => 300000, measureElement: vi.fn(), scrollToIndex
}) }))
afterEach(() => vi.unstubAllGlobals())
describe('Find in virtual transcript data', () => {
  it('counts offscreen matches and scrolls to the last turn when wrapping backwards', async () => {
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn() })
    const segments = Array.from({ length: 3000 }, (_, i) => ({ start: i * 2.4, speaker: 'Speaker 1', text: 'Reunión' }))
    render(<div style={{ overflowY: 'auto', height: 600 }}><TranscriptViewer transcript="fixture" segments={segments} onSeek={vi.fn()} /></div>)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByLabelText('Find in transcript'), { target: { value: 'reunion' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 3000'))
    expect(document.querySelectorAll('mark')).toHaveLength(2)
    fireEvent.keyDown(screen.getByLabelText('Find in transcript'), { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('3000 of 3000')
    expect(scrollToIndex).toHaveBeenCalledWith(2999, { align: 'center' })
  })
})
