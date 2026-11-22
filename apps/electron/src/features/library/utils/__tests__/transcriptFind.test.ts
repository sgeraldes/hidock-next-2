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
  it('labels sections and wraps in both directions', () => {
    const index = buildFindIndex(['summary', 'moments', 'transcript'].map(section => ({ key: section, section: section as 'summary', text: 'reunión' })))
    expect(searchFindIndex(index, 'reunion').map(m => m.section)).toEqual(['summary', 'moments', 'transcript'])
    expect(wrapFindIndex(2, 1, 3)).toBe(0)
    expect(wrapFindIndex(0, -1, 3)).toBe(2)
    expect(wrapFindIndex(0, 1, 0)).toBe(0)
  })
  it('searches a precomputed 3,000-segment index in under 50ms per keystroke', () => {
    const makeDocuments = (count: number) => Array.from({ length: count }, (_, i) => ({ key: `turn:${i}`, section: 'transcript' as const, timeMs: i * 2400, text: `Sebastián: Esta reunión revisa las decisiones y próximos pasos. ${'Texto de la conversación. '.repeat(12)}` }))
    // The budget is per keystroke in a running app. Compile the search path on a
    // separate small index first so a cold JIT is not billed to the first letter
    // (it measured 53 ms once under machine load while the rest stayed under 3 ms).
    const warmup = buildFindIndex(makeDocuments(50))
    for (let i = 0; i < 20; i++) searchFindIndex(warmup, i % 2 ? 'reunion' : 'r')
    const index = buildFindIndex(makeDocuments(3000))
    const times = ['r', 're', 'reu', 'reun', 'reuni', 'reunion'].map(query => {
      const start = performance.now()
      expect(searchFindIndex(index, query).length).toBeGreaterThan(0)
      return performance.now() - start
    })
    console.log('Find 3000 segments keystroke ms:', times)
    expect(Math.max(...times)).toBeLessThan(50)
  })
})
