import { describe, it, expect } from 'vitest'
import { dateGroupLabel, coarseDateGroup, coarseDateGroupLabel } from '../dateGroups'

const now = new Date(2026, 8, 28, 9, 0) // 28 Sep 2026, 09:00 local

describe('dateGroupLabel', () => {
  it('names the recent days and then the month', () => {
    expect(dateGroupLabel(new Date(2026, 8, 28, 1, 0), now)).toBe('Today')
    expect(dateGroupLabel(new Date(2026, 8, 27, 23, 0), now)).toBe('Yesterday')
    expect(dateGroupLabel(new Date(2026, 8, 23, 12, 0), now)).toBe('This week')
    expect(dateGroupLabel(new Date(2026, 8, 20, 12, 0), now)).toMatch(/2026/)
    expect(dateGroupLabel(new Date(2025, 4, 12), now)).toMatch(/2025/)
  })

  it('names yesterday across a daylight-saving change (25-hour day)', () => {
    // Europe and the US fall back on a Sunday; any 25-hour gap between local
    // midnights must still count as one calendar day.
    const afterFallBack = new Date(2026, 9, 26, 9, 0)
    expect(dateGroupLabel(new Date(2026, 9, 25, 12, 0), afterFallBack)).toBe('Yesterday')
    expect(dateGroupLabel(new Date(2026, 2, 29, 12, 0), new Date(2026, 2, 30, 9, 0))).toBe('Yesterday')
  })

  it('does not call a future date Today', () => {
    expect(dateGroupLabel(new Date(2026, 8, 29, 12, 0), now)).toMatch(/2026/)
    expect(dateGroupLabel(new Date(2027, 1, 1), now)).toMatch(/2027/)
  })

  it('gives nothing for a missing or broken date', () => {
    expect(dateGroupLabel(null, now)).toBeNull()
    expect(dateGroupLabel('not a date', now)).toBeNull()
  })
})

describe('coarseDateGroup', () => {
  it('buckets into today, this week, earlier this month, and older', () => {
    expect(coarseDateGroup(new Date(2026, 8, 28, 1, 0), now)).toBe('today')
    expect(coarseDateGroup(new Date(2026, 8, 27, 23, 0), now)).toBe('week') // yesterday
    expect(coarseDateGroup(new Date(2026, 8, 22, 12, 0), now)).toBe('week') // 6 days ago
    expect(coarseDateGroup(new Date(2026, 8, 20, 12, 0), now)).toBe('earlier') // still September
    expect(coarseDateGroup(new Date(2026, 8, 1, 12, 0), now)).toBe('earlier')
    expect(coarseDateGroup(new Date(2026, 7, 31, 12, 0), now)).toBe('older') // August
    expect(coarseDateGroup(new Date(2025, 8, 28, 12, 0), now)).toBe('older') // a year back
  })

  it('keeps a future date with today, never as older', () => {
    expect(coarseDateGroup(new Date(2026, 8, 29, 12, 0), now)).toBe('today')
    expect(coarseDateGroup(new Date(2027, 0, 1), now)).toBe('today')
  })

  it('labels the buckets in plain words and gives nothing for a broken date', () => {
    expect(coarseDateGroupLabel(new Date(2026, 8, 28), now)).toBe('Today')
    expect(coarseDateGroupLabel(new Date(2026, 8, 24), now)).toBe('This week')
    expect(coarseDateGroupLabel(new Date(2026, 8, 3), now)).toBe('Earlier')
    expect(coarseDateGroupLabel(new Date(2026, 6, 3), now)).toBe('Older')
    expect(coarseDateGroup(null, now)).toBeNull()
    expect(coarseDateGroupLabel('not a date', now)).toBeNull()
  })
})
