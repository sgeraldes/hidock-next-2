import { describe, it, expect } from 'vitest'
import { countLineIssues, lineIssues } from '../transcript-line-issues'

describe('transcript line rules', () => {
  it('marks the later line of a repeat, the line that goes back, and untimed lines', () => {
    const perLine = lineIssues([
      { start: 10, end: 12, text: 'uno' },
      { start: 10, end: 12, text: 'dos' },
      { start: 8, end: 9, text: 'tres' },
      { start: null, end: null, text: 'cuatro' }
    ])
    expect(perLine).toEqual([[], ['repeated_start'], ['backwards_start'], ['untimed_lines']])
    expect(countLineIssues(perLine)).toEqual({ repeated_start: 1, backwards_start: 1, cramped_lines: 0, untimed_lines: 1 })
  })

  it('ignores a start less than half a second earlier (jitter)', () => {
    expect(lineIssues([{ start: 10, end: 11, text: 'a' }, { start: 9.7, end: 11, text: 'b' }])).toEqual([[], []])
  })

  it('marks a line whose words cannot fit before the next start', () => {
    const words = 'una dos tres cuatro cinco seis siete ocho nueve diez'
    expect(lineIssues([{ start: 0, end: 1, text: words }, { start: 1, end: 2, text: 'fin' }])[0]).toEqual(['cramped_lines'])
  })
})
