import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TranscriptViewer } from '../TranscriptViewer'
import { ReaderFindBar, useReaderFind } from '../ReaderFind'

const timedDocs = [{ key: 'turn:0', section: 'transcript' as const, text: 'Reunión', timeMs: 30000 }]
function ExternalReader({ normalSeek, findSeek }: { normalSeek: (ms: number) => void; findSeek: (ms: number) => void }) {
  const find = useReaderFind({ sourceId: 'recording', documents: timedDocs, onSeek: findSeek })
  return <div ref={find.rootRef}><ReaderFindBar find={find} /><TranscriptViewer find={find} transcript="[00:30] Reunión" onSeek={normalSeek} /></div>
}

describe('Standalone recording transcript find', () => {
  it('uses the paused find seek path when clicking a matching turn timestamp', async () => {
    const normalSeek = vi.fn(), findSeek = vi.fn()
    render(<ExternalReader normalSeek={normalSeek} findSeek={findSeek} />)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByLabelText('Find in transcript'), { target: { value: 'reunion' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Jump to 0:30' }))
    expect(findSeek).toHaveBeenCalledWith(30000)
    expect(normalSeek).not.toHaveBeenCalled()
  })
  it('routes Ctrl+F to the focused recording and clears the previous reader', async () => {
    const { container } = render(<><TranscriptViewer transcript="[00:10] First: reunión" onSeek={vi.fn()} /><TranscriptViewer transcript="[00:20] Second: reunión" onSeek={vi.fn()} /></>)
    const readers = container.querySelectorAll<HTMLElement>('[data-reader-find]')
    fireEvent.keyDown(readers[0], { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByLabelText('Find in transcript'), { target: { value: 'reunion' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 1'))
    fireEvent.keyDown(readers[1], { key: 'f', ctrlKey: true })
    expect(screen.getAllByLabelText('Find in transcript')).toHaveLength(1)
    expect(screen.getByLabelText('Find in transcript')).toHaveValue('')
    expect(document.querySelectorAll('mark')).toHaveLength(0)
  })
  it('finds speaker names and reveals collapsed summary and actions', async () => {
    render(<TranscriptViewer transcript="[00:30] Sebastián: Reunión importante." summary="Resumen de la reunión." actionItems={['Preparar la reunión.']} onSeek={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Action Items' }))
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByLabelText('Find in transcript')
    fireEvent.change(input, { target: { value: 'reunion' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 3 · Summary'))
    expect(screen.getByRole('button', { name: 'Summary' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 · Actions & decisions')
    expect(screen.getByRole('button', { name: 'Action Items' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(input, { target: { value: 'sebastian' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 1 · Transcript'))
    expect(screen.getByText('Sebastián', { selector: 'mark' })).toHaveAttribute('data-find-current', 'true')
    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled())
  })
  it('keeps immediate input handling below 50ms on 3,000 segments', async () => {
    const segments = Array.from({ length: 3000 }, (_, i) => ({ speaker: 'Sebastián', start: i * 2.4, text: 'Esta reunión revisa una decisión y los próximos pasos.' }))
    render(<TranscriptViewer transcript="" segments={segments} onSeek={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByLabelText('Find in transcript')
    const start = performance.now()
    fireEvent.change(input, { target: { value: 'reunion' } })
    expect(performance.now() - start).toBeLessThan(50)
    expect(input).toHaveValue('reunion')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 3000'), { timeout: 15000 })
    expect(document.querySelectorAll('mark')).toHaveLength(3000)
  })
})
