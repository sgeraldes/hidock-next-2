import { describe, it, expect } from 'vitest'
import { applyCalendarWindow, calendarWindow } from '../calendar-window'

describe('calendar window', () => {
  it('one window for every calendar source: 60 back and 120 ahead by default', () => {
    applyCalendarWindow({})
    expect(calendarWindow()).toEqual({ pastDays: 60, futureDays: 120 })
    applyCalendarWindow({ calendar: { windowPastDays: 30, windowFutureDays: 0 } })
    expect(calendarWindow()).toEqual({ pastDays: 30, futureDays: 120 })
  })
})
