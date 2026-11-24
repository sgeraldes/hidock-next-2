import { getDayDates, getMonthDates, getWeekDates, getWorkweekDates, normalizeWeekStart, type CalendarViewType } from './calendar-utils'

/** The local days actually drawn, including the leading/trailing month cells. */
export function calendarViewRange(date: Date, view: CalendarViewType, weekStart?: string | number) {
  const dates = view === 'month' ? getMonthDates(date, normalizeWeekStart(weekStart))
    : view === 'workweek' ? getWorkweekDates(date)
      : view === 'day' ? getDayDates(date) : getWeekDates(date, normalizeWeekStart(weekStart))
  const end = new Date(dates[dates.length - 1])
  const start = new Date(dates[0])
  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)
  return { startDate: start.toISOString(), endDate: end.toISOString() }
}
