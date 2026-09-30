import { describe, it, expect } from 'vitest'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Meeting } from '@/types'
import { compareDerived, defaultSortOrder, derivedSortValue, isDerivedSort } from '../sortKeys'

const base: UnifiedRecording = {
  id: 'r1',
  filename: '2026Sep24-101500-Rec12.hda',
  dateRecorded: new Date('2026-09-24T10:15:00'),
  duration: 600,
  size: 1,
  location: 'local-only',
  syncStatus: 'synced',
  localPath: '/tmp/rec.wav',
  transcriptionStatus: 'complete'
}

describe('defaultSortOrder', () => {
  it('starts date, length, quality, stars and meeting from the top, and titles A to Z', () => {
    for (const key of ['date', 'duration', 'quality', 'stars', 'meeting'] as const) {
      expect(defaultSortOrder(key), key).toBe('desc')
    }
    for (const key of ['name', 'status', 'transcription'] as const) {
      expect(defaultSortOrder(key), key).toBe('asc')
    }
  })
})

describe('derived sort values', () => {
  it('knows which keys need one', () => {
    for (const key of ['name', 'stars', 'meeting', 'status', 'transcription'] as const) {
      expect(isDerivedSort(key), key).toBe(true)
    }
    for (const key of ['date', 'duration', 'quality'] as const) {
      expect(isDerivedSort(key), key).toBe(false)
    }
  })

  it('title sorts on what the list shows, not on the file name', () => {
    const meeting = { id: 'm1', subject: 'Zeta review' } as Meeting
    const titled = derivedSortValue('name', { ...base, userTitle: 'Alpha kickoff' }, {})
    const bySubject = derivedSortValue('name', { ...base, meetingId: 'm1' }, { meeting })
    expect(titled).toBe('alpha kickoff')
    expect(bySubject).toBe('zeta review')
    expect(String(titled)).not.toContain('rec12')
  })

  it('stars: unevaluated counts as none', () => {
    expect(derivedSortValue('stars', { ...base, evalStarLevel: 4 }, {})).toBe(4)
    expect(derivedSortValue('stars', base, {})).toBe(0)
  })

  it('meeting: linked is 1, unlinked 0', () => {
    expect(derivedSortValue('meeting', { ...base, meetingId: 'm1' }, {})).toBe(1)
    expect(derivedSortValue('meeting', base, {})).toBe(0)
  })

  it('status puts a processing error before where the file is', () => {
    const error = { message: 'x' } as never
    const both = { ...base, location: 'both', deviceFilename: 'x.hda' } as UnifiedRecording
    const deviceOnly = { ...base, location: 'device-only', deviceFilename: 'x.hda' } as unknown as UnifiedRecording
    expect(derivedSortValue('status', both, { error })).toBeLessThan(Number(derivedSortValue('status', deviceOnly, {})))
  })
})

describe('compareDerived', () => {
  it('orders numbers in both directions', () => {
    expect(compareDerived(1, 3, 'asc')).toBeLessThan(0)
    expect(compareDerived(1, 3, 'desc')).toBeGreaterThan(0)
    expect(compareDerived(2, 2, 'asc')).toBe(0)
  })

  it('orders titles as text, in both directions', () => {
    expect(compareDerived('alpha', 'beta', 'asc')).toBeLessThan(0)
    expect(compareDerived('alpha', 'beta', 'desc')).toBeGreaterThan(0)
  })
})
