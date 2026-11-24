import { describe, expect, it } from 'vitest'
import { buildFindIndex, searchFindIndex, wrapFindIndex } from '../transcriptFind'

describe('reader find index', () => {
  it('matches literal phrases case and accent insensitively with original offsets', () => {
    const index = buildFindIndex([{ key: 'turn:0', section: 'transcript', text: 'Sebastián: REUNIÓN reunión reu\u0301nion', timeMs: 30000 }])
    expect(searchFindIndex(index, 'reunion').map(m => [m.start, m.end, m.timeMs])).toEqual([[11, 18, 30000], [19, 26, 30000], [27, 35, 30000]])
    expect(searchFindIndex(index, 'sebastian')).toHaveLength(1)
    expect(searchFindIndex(index, '')).toEqual([])
    expect(searchFindIndex(index, '.*')).toEqual([])
  })
  it('gives plain ASCII text the same offsets as accented text', () => {
    const index = buildFindIndex([{ key: 'a', section: 'transcript', text: 'The Budget and the BUDGET' }, { key: 'b', section: 'transcript', text: 'Él y el budget' }])
    expect(searchFindIndex(index, 'budget').map(m => [m.key, m.start, m.end])).toEqual([['a', 4, 10], ['a', 19, 25], ['b', 8, 14]])
  })
  it('folds Greek final sigma the same in the text and the query', () => {
    const index = buildFindIndex([{ key: 'a', section: 'transcript', text: 'ΟΔΥΣΣΕΥΣ και Οδυσσεύς' }])
    expect(searchFindIndex(index, 'ΕΥΣ').map(m => [m.start, m.end])).toEqual([[5, 8], [18, 21]])
    expect(searchFindIndex(index, 'ευς')).toHaveLength(2)
  })
  it('labels sections and wraps in both directions', () => {
    const index = buildFindIndex(['summary', 'moments', 'transcript'].map(section => ({ key: section, section: section as 'summary', text: 'reunión' })))
    expect(searchFindIndex(index, 'reunion').map(m => m.section)).toEqual(['summary', 'moments', 'transcript'])
    expect(wrapFindIndex(2, 1, 3)).toBe(0)
    expect(wrapFindIndex(0, -1, 3)).toBe(2)
    expect(wrapFindIndex(0, 1, 0)).toBe(0)
  })
  it('searches a precomputed 3,000-segment index in under 50ms per keystroke', () => {
    const makeDocuments = (count: number) => Array.from({ length: count }, (_, i) => ({ key: `turn:${i}`, section: 'transcript' as const, timeMs: i * 2400, text: `Sebastián: Esta reunión revisa las decisiones y próximos pasos. ${'Texto de la conversación. '.repeat(12)}` }))
    // The budget is per keystroke in a running app. The first large search in a
    // process compiles the match loop and grows the heap: 18 ms here, 74 ms on
    // the CI runner, while the same "r" (45,000 matches) then takes 2.5 ms.
    // Warm up on this index with letters outside the measured queries. The
    // first (cold) search keeps a loose bound so a regression there still fails.
    // Both bounds count this worker's CPU time, not wall time: under the full
    // suite on a loaded machine the cold search waited for a core and measured
    // 273 ms of wall time (24-nov-2026) while doing the same work.
    const cpuMs = (run: () => void): number => {
      const start = process.cpuUsage()
      run()
      const used = process.cpuUsage(start)
      return (used.user + used.system) / 1000
    }
    const index = buildFindIndex(makeDocuments(3000))
    const coldMs = cpuMs(() => searchFindIndex(index, 'e'))
    for (const letter of ['a', 'o']) searchFindIndex(index, letter)
    const times = ['r', 're', 'reu', 'reun', 'reuni', 'reunion'].map(query =>
      cpuMs(() => expect(searchFindIndex(index, query).length).toBeGreaterThan(0)))
    console.log('Find 3000 segments cold ms:', coldMs, 'keystroke ms:', times)
    expect(coldMs).toBeLessThan(250)
    expect(Math.max(...times)).toBeLessThan(50)
  })
})
