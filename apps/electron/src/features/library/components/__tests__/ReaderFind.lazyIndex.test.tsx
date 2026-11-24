import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import * as transcriptFind from '../../utils/transcriptFind'
import { useReaderFind, ReaderFindBar } from '../ReaderFind'

vi.mock('../../utils/transcriptFind', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/transcriptFind')>()
  return { ...actual, buildFindIndex: vi.fn(actual.buildFindIndex) }
})

const docs = [{ key: 'turn:0', section: 'transcript' as const, text: 'reunión', timeMs: 1000 }]
function Harness() {
  const find = useReaderFind({ sourceId: 'a', documents: docs, onSeek: vi.fn() })
  return <div ref={find.rootRef}><ReaderFindBar find={find} /></div>
}

describe('Reader find index cost', () => {
  it('normalizes the source only while the find bar is open', async () => {
    const build = vi.mocked(transcriptFind.buildFindIndex)
    render(<Harness />)
    expect(build.mock.calls.every(([documents]) => documents.length === 0)).toBe(true)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByLabelText('Find in transcript'), { target: { value: 'reunion' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 1'))
    expect(build.mock.calls.some(([documents]) => documents.length === 1)).toBe(true)
  })
})
