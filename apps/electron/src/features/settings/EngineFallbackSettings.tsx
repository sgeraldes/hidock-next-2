import { useCallback, useEffect, useState } from 'react'
import { useConfigStore } from '@/store/domain/useConfigStore'
import {
  DEFAULT_ENGINE_CHAIN_ENTRIES,
  DEFAULT_ENGINE_RETRIES,
  ENGINE_OPTIONS,
  RETRYABLE_ERROR_CLASSES,
  engineOptionLabel,
  type EngineAvailability,
} from '@/shared/transcription-engines'

const selectClass = 'rounded-md border border-input bg-background px-2 py-1 text-sm'
const buttonClass = 'rounded border border-input px-2 py-1 text-xs disabled:opacity-40'

/**
 * Settings > Transcription > Pipeline: what happens when a transcription fails.
 * The engines run in this order; one that cannot run now is skipped and noted.
 * Asked by the owner on 15-oct-2026: retry by error, then move to the Model Host
 * or this computer, and never give up easily.
 */
export function EngineFallbackSettings() {
  const transcription = useConfigStore((s) => s.config?.transcription)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const [availability, setAvailability] = useState<EngineAvailability[] | null>(null)
  const [adding, setAdding] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const chain = transcription?.engineChain?.length ? transcription.engineChain : DEFAULT_ENGINE_CHAIN_ENTRIES
  const fallbackEnabled = transcription?.engineFallbackEnabled !== false
  const splitIncomplete = transcription?.splitIncompleteAudio !== false
  const retries = { ...DEFAULT_ENGINE_RETRIES, ...(transcription?.engineRetries ?? {}) }

  const refresh = useCallback(() => {
    const api = window.electronAPI?.recordings
    if (!api?.getTranscriptionEngineAvailability) return
    api.getTranscriptionEngineAvailability().then(setAvailability, () => setAvailability(null))
  }, [])
  useEffect(refresh, [refresh, transcription?.engineChain, transcription?.modelHostUrl, transcription?.provider])

  const save = async (values: Partial<NonNullable<typeof transcription>>) => {
    setSaving(true)
    setError('')
    try {
      await updateConfig('transcription', values)
    } catch {
      setError('Could not save. The previous setting remains in effect.')
    } finally {
      setSaving(false)
    }
  }
  const saveChain = (next: string[]) => void save({ engineChain: next })
  const move = (index: number, by: number) => {
    const next = [...chain]
    const [entry] = next.splice(index, 1)
    next.splice(index + by, 0, entry)
    saveChain(next)
  }
  const reasonFor = (entry: string) => availability?.find((item) => item.entry === entry)?.unavailableReason
  const options = ENGINE_OPTIONS.filter((option) => !chain.includes(option.value))

  return (
    <section aria-label="When transcription fails" className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">When transcription fails</h3>
        <p className="text-xs text-muted-foreground">
          Each engine is tried in this order. An engine is repeated when its error allows it, and skipped when it cannot
          run now (no key, the Model Host is paused or off, the local runner is missing). Every attempt is kept with its
          reason in the recording.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={fallbackEnabled} disabled={saving}
          onChange={(event) => void save({ engineFallbackEnabled: event.target.checked })} />
        Try the next engine when one fails
      </label>

      <ol aria-label="Engine order" className="space-y-1">
        {chain.map((entry, index) => {
          const reason = reasonFor(entry)
          const muted = !fallbackEnabled && index > 0
          return (
            <li key={entry} className={`flex flex-wrap items-center gap-2 text-sm ${muted ? 'opacity-50' : ''}`}>
              <span className="w-5 text-right text-xs text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0 flex-1">
                {engineOptionLabel(entry)}
                <span className="ml-2 text-xs text-muted-foreground">
                  {availability === null ? '' : reason ? `Unavailable now: ${reason}` : 'Available'}
                </span>
              </span>
              <button type="button" className={buttonClass} disabled={saving || index === 0}
                aria-label={`Move ${engineOptionLabel(entry)} up`} onClick={() => move(index, -1)}>Up</button>
              <button type="button" className={buttonClass} disabled={saving || index === chain.length - 1}
                aria-label={`Move ${engineOptionLabel(entry)} down`} onClick={() => move(index, 1)}>Down</button>
              <button type="button" className={buttonClass} disabled={saving || chain.length === 1}
                aria-label={`Remove ${engineOptionLabel(entry)}`}
                onClick={() => saveChain(chain.filter((value) => value !== entry))}>Remove</button>
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <select id="engineChainAdd" aria-label="Engine to add" className={selectClass} value={adding} disabled={saving || !options.length}
          onChange={(event) => setAdding(event.target.value)}>
          <option value="">Add an engine…</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <button type="button" className={buttonClass} disabled={saving || !adding}
          onClick={() => { saveChain([...chain, adding]); setAdding('') }}>Add</button>
        <button type="button" className={buttonClass} disabled={saving}
          onClick={() => saveChain([...DEFAULT_ENGINE_CHAIN_ENTRIES])}>Use the measured order</button>
        <button type="button" className={buttonClass} disabled={saving} onClick={refresh}>Check availability</button>
      </div>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Tries again on the same engine</legend>
        {RETRYABLE_ERROR_CLASSES.map((errorClass) => (
          <label key={errorClass.id} className="flex items-center gap-2 text-sm">
            <select className={selectClass} value={retries[errorClass.id]} disabled={saving}
              aria-label={`Retries for ${errorClass.label}`}
              onChange={(event) => void save({ engineRetries: { ...retries, [errorClass.id]: Number(event.target.value) } })}>
              {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            {errorClass.label}
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          A missing key, an unreadable file or an engine the Model Host has not prepared is never repeated: the next engine runs.
        </p>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={splitIncomplete} disabled={saving}
          onChange={(event) => void save({ splitIncompleteAudio: event.target.checked })} />
        When Gemini returns an incomplete answer, send that piece again in halves
      </label>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  )
}
