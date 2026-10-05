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
    const index = buildFindIndex(Array.from({ length: 3000 }, (_, i) => ({ key: `turn:${i}`, section: 'transcript', timeMs: i * 2400, text: `Sebastián: Esta reunión revisa las decisiones y próximos pasos. ${'Texto de la conversación. '.repeat(12)}` })))
    const times = ['r', 're', 'reu', 'reun', 'reuni', 'reunion'].map(query => {
      const start = performance.now()
      expect(searchFindIndex(index, query).length).toBeGreaterThan(0)
      return performance.now() - start
    })
    console.log('Find 3000 segments keystroke ms:', times)
    expect(Math.max(...times)).toBeLessThan(50)
  })
})
