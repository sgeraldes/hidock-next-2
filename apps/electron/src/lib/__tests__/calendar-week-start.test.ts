/**
 * The week and month views start on the same day, the one in ui.startOfWeek
 * (they used to start on Monday and on Sunday).
 */
import { describe, it, expect } from 'vitest'
import {
  getMonthDates,
  getWeekDates,
  getWorkweekDates,
  normalizeWeekStart,
  startOfWeekDate,
  weekdayHeaders,
} from '../calendar-utils'

const wed = new Date(2026, 8, 30) // Wednesday 30 Sep 2026

describe('week start', () => {
  it('starts the week on Monday by default and on the configured day otherwise', () => {
    expect(startOfWeekDate(wed).getDate()).toBe(28)
    expect(startOfWeekDate(wed, 0).getDate()).toBe(27)
    expect(startOfWeekDate(wed, 6).getDate()).toBe(26)
    expect(getWeekDates(wed, 0).map((d) => d.getDay())).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('month grid rows begin on the same day as the week', () => {
    for (const ws of [0, 1, 6]) {
      const grid = getMonthDates(wed, ws)
      expect(grid.length % 7).toBe(0)
      expect(grid[0].getDay()).toBe(ws)
      expect(grid[grid.length - 1].getDay()).toBe((ws + 6) % 7)
      expect(grid.some((d) => d.getMonth() === 8 && d.getDate() === 1)).toBe(true)
      expect(grid.some((d) => d.getMonth() === 8 && d.getDate() === 30)).toBe(true)
    }
  })

  it('workweek is Monday to Friday whatever day the week starts on', () => {
    expect(getWorkweekDates(wed).map((d) => d.getDay())).toEqual([1, 2, 3, 4, 5])
  })

  it('headers follow the start day and name the real weekday', () => {
    expect(weekdayHeaders(0)[0]).toEqual({ day: 0, label: 'Sun' })
    expect(weekdayHeaders(1).map((h) => h.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })

  it('an invalid saved value falls back to Monday', () => {
    expect(normalizeWeekStart(undefined)).toBe(1)
    expect(normalizeWeekStart(9)).toBe(1)
    expect(normalizeWeekStart(0)).toBe(0)
  })
})
