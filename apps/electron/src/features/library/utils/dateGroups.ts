/**
 * Date groups for the Library list (the Kiro Crew sessions list groups by
 * time): Today, Yesterday, This week, then the month ("September 2026").
 */

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
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
