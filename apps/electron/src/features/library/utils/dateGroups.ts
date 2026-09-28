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
  const today = startOfDay(now)
  const day = startOfDay(d)
  if (day >= today) return 'Today'
  if (day >= today - DAY_MS) return 'Yesterday'
  if (day >= today - 6 * DAY_MS) return 'This week'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
