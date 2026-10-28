import { useState } from 'react'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { SUMMARY_RETRY_BOUNDS, summaryRetrySettings, type SummaryRetrySettings as Values } from '@/shared/summary-retry'

const inputClass = 'w-20 rounded-md border border-input bg-background px-2 py-1 text-sm'

/**
 * Settings > Transcription: the automatic retry for summaries every provider
 * failed on. A failed summary first goes to the next available brain in the
 * same run; this only covers the case where all of them failed. Sebastián,
 * 28-oct-2026: configurable, and a manual "Generate summary" in the recording.
 */
export function SummaryRetrySettings() {
  const saved = useConfigStore((s) => s.config?.transcription?.summaryRetry)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const values = summaryRetrySettings(saved)

  const save = async (next: Partial<Values>) => {
    setSaving(true)
    setError('')
    try {
      await updateConfig('transcription', { summaryRetry: summaryRetrySettings({ ...values, ...next }) })
    } catch {
      setError('Could not save. The previous setting remains in effect.')
    } finally {
      setSaving(false)
    }
  }
  const number = (key: 'everyMinutes' | 'perPass' | 'maxPerWeek', label: string, unit: string) => (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-56">{label}</span>
      <input type="number" className={inputClass} aria-label={label} disabled={saving || !values.auto}
        min={SUMMARY_RETRY_BOUNDS[key].min} max={SUMMARY_RETRY_BOUNDS[key].max} defaultValue={values[key]} key={values[key]}
        onBlur={(event) => {
          const n = Number(event.target.value)
          if (Number.isFinite(n) && n !== values[key]) void save({ [key]: n })
        }} />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </label>
  )

  return (
    <section aria-label="When every summary provider fails" className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">When every summary provider fails</h3>
        <p className="text-xs text-muted-foreground">
          A summary that fails goes to the next available AI brain right away, and the one that failed is marked not
          available. When all of them fail, the transcript is kept without a summary. This retries those on its own;
          the recording also has a Generate summary button.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={values.auto} disabled={saving}
          onChange={(event) => void save({ auto: event.target.checked })} />
        Retry failed summaries automatically
      </label>
      {number('everyMinutes', 'Wait before trying again', 'minutes')}
      {number('perPass', 'Summaries per try', 'recordings')}
      {number('maxPerWeek', 'Stop after this many failures a week', 'failures')}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </section>
  )
}
