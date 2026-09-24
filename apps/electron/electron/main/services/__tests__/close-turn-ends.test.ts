import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: class {}, ipcMain: { handle: vi.fn() } }))

const { closeTurnEnds } = await import('../transcription')

describe('closeTurnEnds', () => {
  it('closes a single turn at the end of the recording instead of leaving it zero-length', () => {
    // 22-sep: eight short clips failed with "All diarization segments have invalid timestamps".
    const turns = [{ start: 0, end: 0 }]
    closeTurnEnds(turns, 17)
    expect(turns[0].end).toBe(17)
  })

  it('keeps an end the engine gave when it is after the start', () => {
    const turns = [
      { start: 0, end: 4.2 },
      { start: 5, end: 5 },
    ]
    closeTurnEnds(turns, 9)
    expect(turns.map((t) => t.end)).toEqual([4.2, 9])
  })

  it('runs a start-only turn to the next start', () => {
    const turns = [
      { start: 0, end: 0 },
      { start: 3, end: 3 },
      { start: 8, end: 8 },
    ]
    closeTurnEnds(turns, 12)
    expect(turns.map((t) => t.end)).toEqual([3, 8, 12])
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
