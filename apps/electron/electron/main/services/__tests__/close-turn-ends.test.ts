import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: class {}, ipcMain: { handle: vi.fn() } }))

const { closeTurnEnds } = await import('../transcription')

describe('closeTurnEnds', () => {
  it('gives a single turn the length its text takes to say, instead of zero', () => {
    // 22-sep: eight short clips failed with "All diarization segments have invalid timestamps".
    const turns = [{ start: 0, end: 0, text: 'hola buen dia como estas todo bien' }]
    closeTurnEnds(turns, 17)
    expect(turns[0].end).toBeCloseTo(7 / 2.5)
  })

  it('does not run the last turn to the end of the file (trailing silence is not speech)', () => {
    const turns = [{ start: 10, end: 10, text: 'gracias chau' }]
    closeTurnEnds(turns, 600)
    expect(turns[0].end).toBeCloseTo(11)
  })

  it('never ends a turn past the recording', () => {
    const turns = [{ start: 15, end: 15, text: 'una frase bastante larga que no entra en lo que queda del audio' }]
    closeTurnEnds(turns, 17)
    expect(turns[0].end).toBe(17)
  })

  it('keeps an end the engine gave when it is after the start', () => {
    const turns = [
      { start: 0, end: 4.2 },
      { start: 5, end: 5, text: 'dale' },
    ]
    closeTurnEnds(turns, 9)
    expect(turns.map((t) => t.end)).toEqual([4.2, 6])
  })

  it('runs a start-only turn to the next start', () => {
    const turns = [
      { start: 0, end: 0 },
      { start: 3, end: 3 },
      { start: 8, end: 8, text: 'uno dos tres cuatro cinco' },
    ]
    closeTurnEnds(turns, 12)
    expect(turns.map((t) => t.end)).toEqual([3, 8, 10])
  })

  it('invents nothing when there is no honest end', () => {
    const turns = [
      { start: 5, end: 5 },
      { start: 5, end: 5 },
    ]
    closeTurnEnds(turns)
    expect(turns.map((t) => t.end)).toEqual([5, 5])
  })
})
