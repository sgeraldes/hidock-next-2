import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useReaderFind, ReaderFindBar, FindText } from '../ReaderFind'

const docs = [{ key: 'summary', section: 'summary' as const, text: 'reunión' }, { key: 'turn:0', section: 'transcript' as const, text: 'reunión reunión', timeMs: 30000 }]
function Harness({ source = 'a', seek = vi.fn(), reveal = vi.fn() }) {
  const find = useReaderFind({ sourceId: source, documents: docs, onSeek: seek, onReveal: reveal })
  return <div ref={find.rootRef}><ReaderFindBar find={find} /><input aria-label="Other editor" /><p tabIndex={0} data-testid="reader-text"><FindText find={find} documentKey="summary" text="reunión" /></p><FindText find={find} documentKey="turn:0" text="reunión reunión" /></div>
}
describe('Reader find interactions', () => {
  it('opens from text, ignores another input, counts, wraps, reveals, seeks, and clears on Escape', async () => {
    const seek = vi.fn(), reveal = vi.fn()
    render(<Harness seek={seek} reveal={reveal} />)
    fireEvent.keyDown(screen.getByLabelText('Other editor'), { key: 'f', ctrlKey: true })
    expect(screen.queryByLabelText('Find in transcript')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('reader-text'), { key: 'f', ctrlKey: true })
    const input = screen.getByLabelText('Find in transcript')
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'reunion' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 3'))
    expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ section: 'summary' }))
    expect(document.querySelectorAll('mark')).toHaveLength(3)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('3 of 3')
    fireEvent.keyDown(input, { key: 'Enter', altKey: true })
    expect(seek).toHaveBeenCalledWith(30000)
    fireEvent.click(screen.getByRole('button', { name: 'Seek to 0:30' }))
    expect(seek).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(input, { key: 'F3' })
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3')
    fireEvent.keyDown(input, { key: 'F3', shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('3 of 3')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('Find in transcript')).not.toBeInTheDocument()
    expect(document.querySelectorAll('mark')).toHaveLength(0)
  })
  it('clears the query when the source changes and leaves Ctrl+K alone', async () => {
    const { rerender } = render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.queryByLabelText('Find in transcript')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByLabelText('Find in transcript'), { target: { value: 'reunion' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 3'))
    rerender(<Harness source="b" />)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByLabelText('Find in transcript')).toHaveValue('')
  })
})
