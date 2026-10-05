import { describe, expect, it } from 'vitest'
import { labelDisplayOrder } from '../label-display-order'

describe('label display order', () => {
  const items = Array.from({ length: 40 }, (_, position) => ({
    recordingId: `recording-${position}`, position, answer: position === 7 ? 'interview' : null,
    stratum: position < 20 ? 'doubtful' : 'random'
  }))

  it('mixes both strata instead of exposing the first twenty doubtful recordings', () => {
    const displayed = labelDisplayOrder('fixed-set-id', items)
    expect(new Set(displayed.slice(0, 20).map(item => item.stratum)).size).toBe(2)
    expect(new Set(displayed.slice(20).map(item => item.stratum)).size).toBe(2)
  })

  it('is stable across calls, incoming order and answer changes', () => {
    const ids = (rows: typeof items) => rows.map(row => row.recordingId)
    expect(ids(labelDisplayOrder('fixed-set-id', [...items].reverse()))).toEqual(ids(labelDisplayOrder('fixed-set-id', items)))
    expect(ids(labelDisplayOrder('fixed-set-id', items.map(item => ({ ...item, answer: 'unknown' }))))).toEqual(ids(labelDisplayOrder('fixed-set-id', items)))
  })

  it('preserves recording identity, answers, stored positions and strata without mutating input', () => {
    const original = structuredClone(items)
    const displayed = labelDisplayOrder('fixed-set-id', items)
    expect(displayed).toHaveLength(40)
    expect(new Set(displayed.map(item => item.recordingId)).size).toBe(40)
    for (const item of displayed) expect(item).toBe(items[item.position])
    expect(items).toEqual(original)
    expect(labelDisplayOrder('empty', [])).toEqual([])
  })
})
