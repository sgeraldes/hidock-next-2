/**
 * Date groups for the Library list (the Kiro Crew sessions list groups by
 * time): Today, Yesterday, This week, then the month ("September 2026").
 */

import { appLocale } from '@/lib/locale'
const DAY_MS = 86_400_000

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function dateGroupLabel(date: Date | string | null | undefined, now: Date = new Date()): string | null {
  if (!date) return null
  const d = typeof date === 'string' ? new Date(date) : date
  if (!Number.isFinite(d.getTime())) return null
  // Calendar days back, rounded: a daylight-saving day is 23 or 25 hours long,
  // so fixed 24-hour steps would put yesterday in "This week" once a year.
  const daysAgo = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS)
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  // A future date (a device with a wrong clock) is not "Today": it gets its month.
  if (daysAgo > 1 && daysAgo <= 6) return 'This week'
  return d.toLocaleDateString(appLocale(), { month: 'long', year: 'numeric' })
}

/**
 * Coarse time buckets for the Library list sections (the Kiro Crew sessions
 * list groups this way): Today, This week (the last 7 days), Earlier (older
 * than a week but still in the current calendar month), and Older (everything
 * before this month). "Older" is what the "Show older" control hides by
 * default. A future date (wrong device clock) sorts with Today so it is never
 * mistaken for old. Returns null for a missing/invalid date.
 */
export type CoarseDateGroup = 'today' | 'week' | 'earlier' | 'older'

export const COARSE_GROUP_LABELS: Record<CoarseDateGroup, string> = {
  today: 'Today',
  week: 'This week',
  earlier: 'Earlier',
  older: 'Older'
}

/** Order the sections appear in a date-descending list. */
export const COARSE_GROUP_ORDER: CoarseDateGroup[] = ['today', 'week', 'earlier', 'older']

export function coarseDateGroup(
  date: Date | string | null | undefined,
  now: Date = new Date()
): CoarseDateGroup | null {
  if (!date) return null
  const d = typeof date === 'string' ? new Date(date) : date
  if (!Number.isFinite(d.getTime())) return null
  const daysAgo = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS)
  // A future date is not old; keep it with Today rather than hiding it.
  if (daysAgo <= 0) return 'today'
  if (daysAgo <= 6) return 'week'
  // Within the current calendar month (and year) but more than a week ago.
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'earlier'
  return 'older'
}

export function coarseDateGroupLabel(
  date: Date | string | null | undefined,
  now: Date = new Date()
): string | null {
  const group = coarseDateGroup(date, now)
  return group ? COARSE_GROUP_LABELS[group] : null
}
