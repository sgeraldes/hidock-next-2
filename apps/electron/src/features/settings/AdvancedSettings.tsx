/**
 * Developer > Advanced: the config values with no other control, each with
 * its default (read from the main process) and a Reset.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { ADVANCED_GROUPS, ADVANCED_SETTINGS, parseAdvancedValue, type AdvancedSetting } from './advanced-settings'

type Sections = Record<string, Record<string, unknown> | undefined>

function display(value: unknown): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

function AdvancedRow({ setting, current, fallback, section }: {
  setting: AdvancedSetting
  current: unknown
  fallback: unknown
  section: Record<string, unknown>
}) {
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const [draft, setDraft] = useState(display(current))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Enter saves and then the field loses focus: one save, not two.
  const inFlight = useRef(false)
  const id = `advanced-${setting.section}-${setting.key}`

  useEffect(() => setDraft(display(current)), [current])

  const save = async (raw: string) => {
    if (inFlight.current) return
    if (raw.trim() === display(current).trim()) {
      setError(null)
      return
    }
    const parsed = parseAdvancedValue(setting, raw, section)
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    setError(null)
    setSaving(true)
    inFlight.current = true
    try {
      await updateConfig(setting.section, { [setting.key]: parsed.value } as never)
    } catch (err) {
      setDraft(display(current))
      toast.error(`Could not change ${setting.label.toLowerCase()}`, err instanceof Error ? err.message : undefined)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const isDefault = fallback !== undefined && display(current) === display(fallback)
  return (
    <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_14rem] sm:gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {setting.label}
        </label>
        <p className="text-xs text-muted-foreground">{setting.detail}</p>
        {fallback !== undefined && (
          <p className="text-xs text-muted-foreground">
            Default: <span className="font-mono">{display(fallback) || 'empty'}</span>
            {setting.unit ? ` ${setting.unit}` : ''}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type={setting.kind === 'number' ? 'number' : 'text'}
            inputMode={setting.kind === 'number' ? 'decimal' : undefined}
            min={setting.min}
            max={setting.max}
            step={setting.step}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => void save(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save((e.target as HTMLInputElement).value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="h-8 font-mono text-xs"
            autoComplete="off"
          />
          {!isDefault && fallback !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              disabled={saving}
              onClick={() => void save(display(fallback))}
              aria-label={`Reset ${setting.label} to its default`}
            >
              Reset
            </Button>
          )}
        </div>
        {error && (
          <p id={`${id}-error`} className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

export function AdvancedSettings() {
  const config = useConfigStore((s) => s.config) as unknown as Sections | null
  const [defaults, setDefaults] = useState<Sections | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const getDefaults = window.electronAPI?.config?.getDefaults
    if (!getDefaults) {
      setLoadError('this build cannot read them')
      return
    }
    getDefaults()
      .then((result) => {
        if (!live) return
        if (result?.success) setDefaults(result.data as Sections)
        else setLoadError(result?.error?.message ?? 'The defaults could not be read')
      })
      .catch((err: unknown) => live && setLoadError(err instanceof Error ? err.message : 'The defaults could not be read'))
    return () => {
      live = false
    }
  }, [])

  if (!config) return null
  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4" data-testid="settings-advanced">
      <div>
        <h3 className="text-sm font-semibold">Advanced</h3>
        <p className="text-xs text-muted-foreground">
          Values that tune the pipeline. Each saves when you leave the field; Reset puts back the default.
        </p>
        {loadError && <p className="mt-1 text-xs text-destructive">Defaults unavailable: {loadError}. Reset is hidden.</p>}
      </div>
      {ADVANCED_GROUPS.map((group) => (
        <div key={group}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</h4>
          {ADVANCED_SETTINGS.filter((s) => s.group === group).map((setting) => {
            const section = config[setting.section] ?? {}
            return (
              <AdvancedRow
                key={`${setting.section}.${setting.key}`}
                setting={setting}
                current={section[setting.key]}
                fallback={defaults?.[setting.section]?.[setting.key]}
                section={section}
              />
            )
          })}
        </div>
      ))}
    </section>
  )
}
