/**
 * Settings > Calendar: office hours and work days (they had defaults only in
 * the Calendar page and no control), and how far back and ahead every
 * calendar source reads (one pair for all sources, owner 28-sep-2026).
 * Each control saves on its own.
 */
import { useEffect, useState } from 'react'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { cn } from '@/lib/utils'

const DAYS = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' }
]
const HOURS = Array.from({ length: 25 }, (_, h) => h)

function DaysInput({ id, label, value, onSave }: { id: string; label: string; value: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const v = Number(draft)
    if (!Number.isInteger(v) || v < 1 || v > 3650) {
      toast.error('Enter a whole number of days between 1 and 3650')
      setDraft(String(value))
      return
    }
    if (v !== value) onSave(v)
  }
  return (
    <label htmlFor={id} className="flex items-center gap-1.5 text-sm">
      {label}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        inputMode="numeric"
        className="w-16 rounded-md border border-input bg-background px-2 py-1 text-right"
      />
      days
    </label>
  )
}

export function CalendarPreferences() {
  const ui = useConfigStore((s) => s.config?.ui)
  const calendar = useConfigStore((s) => s.config?.calendar)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const start = ui?.officeHoursStart ?? 9
  const end = ui?.officeHoursEnd ?? 18
  const workDays = ui?.workDays ?? [1, 2, 3, 4, 5]

  const save = (section: 'ui' | 'calendar', values: Record<string, unknown>, what: string) => {
    void updateConfig(section, values as never).catch((err: unknown) =>
      toast.error(`Could not change ${what}`, err instanceof Error ? err.message : undefined)
    )
  }

  return (
    <div className="space-y-4 border-t border-border pt-4" data-testid="calendar-preferences">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Office hours</span>
        <select
          id="officeHoursStart"
          aria-label="Office hours start"
          className="rounded-md border border-input bg-background px-2 py-1"
          value={start}
          onChange={(e) => {
            const v = Number(e.target.value)
            save('ui', v < end ? { officeHoursStart: v } : { officeHoursStart: v, officeHoursEnd: Math.min(24, v + 1) }, 'office hours')
          }}
        >
          {HOURS.slice(0, 24).map((h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}:00
            </option>
          ))}
        </select>
        <span>to</span>
        <select
          id="officeHoursEnd"
          aria-label="Office hours end"
          className="rounded-md border border-input bg-background px-2 py-1"
          value={end}
          onChange={(e) => save('ui', { officeHoursEnd: Number(e.target.value) }, 'office hours')}
        >
          {HOURS.filter((h) => h > start).map((h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}:00
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm">Work days</p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Work days">
          {DAYS.map(({ day, label }) => {
            const on = workDays.includes(day)
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? workDays.filter((d) => d !== day) : [...workDays, day].sort((a, b) => a - b)
                  if (next.length === 0) return
                  save('ui', { workDays: next }, 'work days')
                }}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent'
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            How far every calendar source reads, the feed and Microsoft 365 alike. Microsoft 365 applies a new
            window the next time it starts a full sync.
          </p>
          <div className="flex flex-wrap gap-4">
            <DaysInput id="windowPastDays" label="Back" value={calendar?.windowPastDays ?? 60} onSave={(v) => save('calendar', { windowPastDays: v }, 'the calendar window')} />
            <DaysInput id="windowFutureDays" label="Ahead" value={calendar?.windowFutureDays ?? 120} onSave={(v) => save('calendar', { windowFutureDays: v }, 'the calendar window')} />
          </div>
        </div>
      </details>
    </div>
  )
}
