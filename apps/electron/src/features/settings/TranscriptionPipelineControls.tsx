/**
 * Settings > Transcription > Pipeline: what happens to every recording,
 * whichever service transcribes it. Each control saves on its own.
 *
 * Auto-transcribe is the same key as the switch on the Device page (one key,
 * two places, owner rule 28-sep-2026).
 */
import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'

const LANGUAGES = [
  { value: 'es', label: 'Spanish' },
  { value: 'en', label: 'English' },
  { value: 'pt', label: 'Portuguese' },
  { value: '', label: 'Detect automatically' }
]

export function TranscriptionPipelineControls() {
  const t = useConfigStore((s) => s.config?.transcription)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const minSeconds = t?.minRecordingSeconds ?? 10
  const [minDraft, setMinDraft] = useState(String(minSeconds))
  useEffect(() => setMinDraft(String(minSeconds)), [minSeconds])

  const save = (values: Record<string, unknown>, what: string) => {
    void updateConfig('transcription', values as never).catch((err: unknown) =>
      toast.error(`Could not change ${what}`, err instanceof Error ? err.message : undefined)
    )
  }

  const saveMin = () => {
    const v = Number(minDraft)
    if (!Number.isFinite(v) || v < 0 || v > 600) {
      toast.error('Enter a number of seconds between 0 and 600')
      setMinDraft(String(minSeconds))
      return
    }
    if (v !== minSeconds) save({ minRecordingSeconds: v }, 'the shortest clip')
  }

  const language = t?.language ?? 'es'
  const knownLanguage = LANGUAGES.some((l) => l.value === language)

  return (
    <section className="space-y-4 rounded-xl border border-border p-4" aria-label="Pipeline" data-testid="transcription-pipeline">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor="autoTranscribeToggle" className="text-sm font-medium">
            Transcribe new recordings automatically
          </label>
          <p className="mt-1 text-xs text-muted-foreground">Also on the Device page. Off: recordings wait until you press Transcribe.</p>
        </div>
        <Switch
          id="autoTranscribeToggle"
          checked={t?.autoTranscribe !== false}
          onCheckedChange={(on) => save({ autoTranscribe: on }, 'automatic transcription')}
          aria-label="Transcribe new recordings automatically"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor="transcriptLanguage" className="text-sm font-medium">
          Language of the recordings
        </label>
        <select
          id="transcriptLanguage"
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={language}
          onChange={(e) => save({ language: e.target.value }, 'the language')}
        >
          {!knownLanguage && <option value={language}>{language}</option>}
          {LANGUAGES.map((l) => (
            <option key={l.value || 'auto'} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor="rateRecordingsToggle" className="text-sm font-medium">
            Rate recordings automatically
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Stars, kind and work or personal after each transcript. Which model rates them is on the Decisions (Jev) page.
          </p>
        </div>
        <Switch
          id="rateRecordingsToggle"
          checked={t?.valueClassificationEnabled !== false}
          onCheckedChange={(on) => save({ valueClassificationEnabled: on }, 'automatic rating')}
          aria-label="Rate recordings automatically"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor="minRecordingSeconds" className="text-sm font-medium">
            Skip clips shorter than
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Not transcribed and rated no value. Applies to new recordings; Maintenance re-checks the old ones.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-sm">
          <input
            id="minRecordingSeconds"
            value={minDraft}
            onChange={(e) => setMinDraft(e.target.value)}
            onBlur={saveMin}
            onKeyDown={(e) => e.key === 'Enter' && saveMin()}
            inputMode="numeric"
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-right"
          />
          seconds
        </span>
      </div>
    </section>
  )
}
