import { describe, expect, it } from 'vitest'
import rec28 from './fixtures/rec28-timing'
import { lineIssues, timingOutlierIndices } from '../transcript-line-issues'

describe('sequence timing outliers (read-only Rec28 fixture, anonymised words)', () => {
  it('marks 8:14, not the correctly ordered 0:13 neighbour', () => {
    const issues = lineIssues(rec28)
    expect(issues[0]).toContain('backwards_start')
    expect(issues[1]).not.toContain('backwards_start')
    expect(timingOutlierIndices(rec28)).toContain(0)
  })
  it('isolates a single high or low interior spike', () => {
    const lines = (starts: number[]) => starts.map(start => ({ start, end: null, text: 'hello' }))
    expect(timingOutlierIndices(lines([0, 1, 100, 3, 4]))).toEqual([2])
    expect(timingOutlierIndices(lines([0, 1, -100, 3, 4]))).toEqual([2])
    expect(timingOutlierIndices(lines([0, 1, 0.8, 3]))).toEqual([])
  })
  it('does not mark the ordered line cramped because the following line is an outlier', () => {
    const lines = [0, 100, 4, 8].map(start => ({ start, end: null, text: 'one two three four five six seven eight nine' }))
    expect(lineIssues(lines)[0]).not.toContain('cramped_lines')
    expect(lineIssues(lines)[1]).toContain('backwards_start')
  })
})
