import { describe, expect, it } from 'vitest'
import rec28 from './fixtures/rec28-timing'
import { countLineIssues, duplicateGroups, lineIssues, timingRanges, type TimedLine } from '../transcript-line-issues'

const lines = (starts: number[]): TimedLine[] =>
  starts.map((start, i) => ({ start, end: start + 0.8, text: `linea ${i} con palabras` }))
const said = (rows: Array<[number, string, string?]>): TimedLine[] =>
  rows.map(([start, text, speaker]) => ({ start, end: start + 1, text, speaker }))

describe('timing ranges: one odd line, or a whole section with shifted times', () => {
  it('reports a single line outside the order as an odd line', () => {
    expect(timingRanges(lines([0, 1, 100, 3, 4]))).toEqual([{ kind: 'odd_line', from: 2, to: 2, lines: [2] }])
  })

  it('reports consecutive lines outside the order as one range, not one flag per line', () => {
    const starts = [0, 10, 20, 500, 510, 520, 530, 30, 40, 50, 60]
    expect(timingRanges(lines(starts))).toEqual([{ kind: 'mistimed_run', from: 3, to: 6, lines: [3, 4, 5, 6] }])
    const perLine = lineIssues(lines(starts))
    expect(perLine.slice(3, 7)).toEqual([['mistimed_run'], ['mistimed_run'], ['mistimed_run'], ['mistimed_run']])
    expect(perLine[2]).toEqual([])
    expect(perLine[7]).toEqual([])
  })

  it('keeps a run together across a hidden line inside it', () => {
    const rows = lines([0, 10, 500, 510, 520, 20, 30])
    rows[3] = { ...rows[3], timingHidden: true }
    expect(timingRanges(rows)).toEqual([{ kind: 'mistimed_run', from: 2, to: 4, lines: [2, 4] }])
  })

  it('Rec28: 8:14 is the odd line, and the "120 horas" tangle is one range', () => {
    const ranges = timingRanges(rec28)
    expect(ranges[0]).toEqual({ kind: 'odd_line', from: 0, to: 0, lines: [0] })
    const tangle = ranges.find((r) => r.from >= 190 && r.to <= 198)
    expect(tangle?.kind).toBe('mistimed_run')
    expect(lineIssues(rec28)[1]).not.toContain('backwards_start')
  })
})

describe('duplicate lines and sections', () => {
  it('Rec28: the same speaker saying "120 horas." twice within seconds is a duplicate; the other speaker\'s echo is not', () => {
    const groups = duplicateGroups(rec28)
    const horas = groups.find((g) => g.copies.includes(195))
    expect(horas).toEqual({ kind: 'line', originals: [193], copies: [195] })
    expect(groups.some((g) => g.originals.includes(191) || g.copies.includes(191))).toBe(false)
    expect(lineIssues(rec28)[195]).toContain('duplicate_line')
    expect(lineIssues(rec28)[193]).not.toContain('duplicate_line')
  })

  it('finds a repeated block of lines as one section', () => {
    const rows = said([
      [0, 'vamos a revisar el presupuesto', 'A'],
      [4, 'cuantas horas tiene el equipo', 'B'],
      [8, 'son ciento veinte horas', 'A'],
      [9, 'vamos a revisar el presupuesto', 'A'],
      [12, 'cuantas horas tiene el equipo', 'B'],
      [15, 'y despues seguimos con otra cosa', 'A']
    ])
    expect(duplicateGroups(rows)).toEqual([{ kind: 'section', originals: [0, 1], copies: [3, 4] }])
  })

  it('leaves alone one-word answers, the other speaker repeating, and repeats far apart', () => {
    expect(duplicateGroups(said([[0, 'Sí.', 'A'], [3, 'bueno', 'B'], [5, 'Sí.', 'A']]))).toEqual([])
    expect(duplicateGroups(said([[0, 'Sí, sí.', 'A'], [3, 'bueno', 'B'], [5, 'Sí, sí.', 'A']]))).toEqual([])
    expect(duplicateGroups(said([[0, 'Buenos días.', 'A'], [2, 'Buenos días.', 'B']]))).toEqual([])
    expect(duplicateGroups(said([[0, 'quien autoriza las ciento veinte horas', 'A'], [2, 'otra cosa', 'B'], [400, 'quien autoriza las ciento veinte horas', 'A']]))).toEqual([])
    expect(duplicateGroups(said([[0, '[Environmental Sounds]'], [2, 'otra cosa', 'B'], [4, '[Environmental Sounds]']]))).toEqual([])
  })

  it('takes a short repeat as an echo while the times are in order, and as a duplicate when a copy is out of order', () => {
    expect(duplicateGroups(said([[0, 'Uh-huh.', 'A'], [2, 'otra cosa', 'B'], [4, 'Uh-huh.', 'A']]))).toEqual([])
    expect(duplicateGroups(said([[0, 'Okay. Perfecto.', 'A'], [2, 'otra cosa', 'B'], [4, 'Okay. Perfecto.', 'A'], [6, 'sigue', 'B']]))).toEqual([])
    expect(duplicateGroups(said([[10, 'ciento veinte horas', 'A'], [12, 'otra cosa', 'B'], [3, 'ciento veinte horas', 'A'], [14, 'sigue', 'B']])))
      .toEqual([{ kind: 'line', originals: [0], copies: [2] }])
  })

  it('ignores hidden lines, so hiding the copy clears the flag', () => {
    const rows = said([[0, 'quien autoriza las ciento veinte horas', 'A'], [2, 'otra cosa', 'B'], [4, 'quien autoriza las ciento veinte horas', 'A']])
    expect(duplicateGroups(rows)).toHaveLength(1)
    rows[2] = { ...rows[2], timingHidden: true }
    expect(duplicateGroups(rows)).toEqual([])
  })

  it('counts each line once per code', () => {
    const counts = countLineIssues(lineIssues(rec28))
    expect(counts.duplicate_line).toBeGreaterThanOrEqual(1)
    expect(counts.backwards_start).toBeGreaterThanOrEqual(1)
    expect(counts.mistimed_run).toBeGreaterThanOrEqual(2)
  })
})
