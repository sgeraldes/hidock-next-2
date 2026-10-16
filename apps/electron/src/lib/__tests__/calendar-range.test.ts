import { describe, expect, it } from 'vitest'
import { calendarViewRange } from '../calendar-range'
import { getMonthDates } from '../calendar-utils'
describe('visible calendar range', () => {
  it('starts a day at local midnight even when currentDate includes a time', () => {
    const range = calendarViewRange(new Date(2026, 9, 6, 14, 30), 'day')
    const start = new Date(range.startDate), end = new Date(range.endDate)
    expect(start.getHours()).toBe(0); expect(start.getMinutes()).toBe(0)
    expect(end.getHours()).toBe(23); expect(end.getMilliseconds()).toBe(999)
  })
  it('includes every month cell and respects the configured week start', () => {
    const date = new Date(2026, 10, 2)
    const range = calendarViewRange(date, 'month', 0)
    const cells = getMonthDates(date, 0)
    expect(range.startDate).toBe(cells[0].toISOString())
    expect(new Date(range.endDate).getDate()).toBe(cells[cells.length - 1].getDate())
  })
})
