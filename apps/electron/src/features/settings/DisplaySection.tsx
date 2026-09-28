/**
 * Settings > Display: the theme and the format of dates, times and numbers.
 */
import { useConfigStore } from '@/store/domain/useConfigStore'
import { toast } from '@/components/ui/toaster'
import { useTheme } from '@/hooks/useTheme'
import { LOCALE_CHOICES, appLocale } from '@/lib/locale'

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
] as const

export function DisplaySection() {
  const locale = useConfigStore((s) => s.config?.ui?.locale) ?? 'system'
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const { theme, setTheme } = useTheme()
  const sample = new Date(2026, 8, 28, 14, 5)

  return (
    <div className="space-y-4" data-testid="settings-display">
      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="themePreference" className="text-sm">
            Theme
          </label>
          <select
            id="themePreference"
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={theme}
            onChange={(e) => setTheme(e.target.value as (typeof THEMES)[number]['value'])}
          >
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label htmlFor="appLocale" className="text-sm">
              Dates, times and numbers
            </label>
            <select
              id="appLocale"
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={locale}
              onChange={(e) => {
                void updateConfig('ui', { locale: e.target.value } as never).catch((err: unknown) =>
                  toast.error('Could not change the format', err instanceof Error ? err.message : undefined)
                )
              }}
            >
              {LOCALE_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="locale-sample">
            {sample.toLocaleString(appLocale(), { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
            {(2137).toLocaleString(appLocale())} sources
          </p>
        </div>
      </section>
    </div>
  )
}
