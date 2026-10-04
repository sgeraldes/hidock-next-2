import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { Working } from '@/components/ui/working'
import { STEP_META, TEXT_STEP_IDS, type PipelineSettingsState, type TextStepId } from '@/shared/pipeline-config'
import { StepRow } from './pipeline/StepRow'
import { Decisions } from './pipeline/Decisions'

const GROUPS = ['Interactive', 'Speakers', 'Library'] as const

/**
 * Pipeline: which harness, model and effort run each text step, with a fallback, where the text goes, and
 * what each step has cost and how long it takes. A step left on Automatic keeps following Settings > AI
 * providers. One step is open for editing at a time; a save reads the state again so the row shows what is
 * stored.
 */
export function PipelineSection() {
  const [state, setState] = useState<PipelineSettingsState | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<TextStepId | null>(null)
  const loaded = useRef(false)

  const load = useCallback(async () => {
    try {
      const next = await window.electronAPI.pipeline.getState()
      loaded.current = true
      setState(next)
      setFailed(false)
    } catch (e) {
      // Keep what the page already shows when only a refresh fails.
      if (loaded.current) toast.error(`The pipeline settings could not be refreshed: ${e instanceof Error ? e.message : String(e)}`)
      else setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (failed) {
    return (
      <div className="space-y-3" data-testid="settings-pipeline">
        <p className="text-sm">The pipeline settings could not be loaded.</p>
        <Button
          variant="outline"
          onClick={() => {
            setFailed(false)
            void load()
          }}
        >
          <RotateCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    )
  }

  if (!state) return <Working label="Loading the pipeline settings" shape="list" rows={4} />

  return (
    <div className="space-y-6" data-testid="settings-pipeline">
      <p className="text-sm text-muted-foreground">
        Choose what runs each step. A step on Automatic follows Settings &gt; AI providers, as before. The numbers are
        the median of the last 30 days of calls.
      </p>

      <Decisions key={JSON.stringify(state.config.decisions)} state={state} onSaved={load} />

      {GROUPS.map((group) => {
        const steps = TEXT_STEP_IDS.filter((id) => STEP_META[id].group === group && id !== 'kind-pick')
        return (
          <section key={group} aria-labelledby={`pipeline-group-${group}`} className="space-y-2">
            <h3 id={`pipeline-group-${group}`} className="text-sm font-semibold">
              {group}
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {steps.map((step) => (
                <StepRow
                  key={step}
                  step={step}
                  state={state}
                  editing={open === step}
                  onEdit={() => setOpen(step)}
                  onClose={() => setOpen(null)}
                  onSaved={() => {
                    setOpen(null)
                    void load()
                  }}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
