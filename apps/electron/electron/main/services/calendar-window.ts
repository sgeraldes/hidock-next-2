/**
 * How far back and ahead every calendar source reads (Settings > Calendar,
 * Advanced). The ICS feed used 60 days back and 90 ahead, Microsoft 365 30
 * and 120 (settings map B-10); the owner picked one pair, 60 and 120
 * (28-sep-2026). Pure module refreshed by config.ts, so the connector does not
 * import the config.
 */

export const DEFAULT_CALENDAR_WINDOW = { pastDays: 60, futureDays: 120 }

let current = { ...DEFAULT_CALENDAR_WINDOW }

function days(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 3650 ? Math.round(v) : fallback
}

export function applyCalendarWindow(config: { calendar?: { windowPastDays?: unknown; windowFutureDays?: unknown } }): void {
  current = {
    pastDays: days(config.calendar?.windowPastDays, DEFAULT_CALENDAR_WINDOW.pastDays),
    futureDays: days(config.calendar?.windowFutureDays, DEFAULT_CALENDAR_WINDOW.futureDays)
  }
}

export function calendarWindow(): { pastDays: number; futureDays: number } {
  return current
}
