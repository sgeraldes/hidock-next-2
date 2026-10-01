import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import {
  AUTO_PROFILE,
  STEP_META,
  applyStepDraft,
  issuesForStep,
  validatePipelineConfig,
  type ModelOption,
  type PipelineSettingsState,
  type TextStepId,
  type ValidationIssue
} from '@/shared/pipeline-config'
import { ChoiceFields } from './ChoiceFields'
import { draftFromConfig, toStepChoice, type ChoiceFields as Fields, type StepDraftFields } from './describe'

interface Props {
  step: TextStepId
  state: PipelineSettingsState
  onClose: () => void
  /** The step was saved: the page reads the state again and closes the editor. */
  onSaved: () => void
}

/**
 * The editor of one step. It builds the configuration the draft would make with the same functions the
 * main process uses to accept it (`applyStepDraft`, `validatePipelineConfig`), so what it shows live is what
 * the save will decide. A harness that is down cannot be picked; a slow harness on a step that runs in bulk
 * needs one confirmation.
 */
export function StepEditor({ step, state, onClose, onSaved }: Props) {
  const meta = STEP_META[step]
  const [draft, setDraft] = useState<StepDraftFields>(() => draftFromConfig(state.config, step))
  const [confirmed, setConfirmed] = useState(false)
  const [forceConfirm, setForceConfirm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<ValidationIssue[]>([])
  const [models, setModels] = useState<Record<string, ModelOption[]>>({})

  const primary = toStepChoice(draft.primary, state.harnesses) ?? AUTO_PROFILE
  const fallback = toStepChoice(draft.fallback, state.harnesses)

  const issues = useMemo(() => {
    const candidate = applyStepDraft(state.config, step, primary, fallback)
    return issuesForStep(candidate, validatePipelineConfig(candidate, state.harnesses), step)
    // primary and fallback are derived from draft and the harness list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, state.config, state.harnesses, step])
  const errors = issues.filter((i) => i.severity === 'error')
  const slow = issues.filter((i) => i.code === 'slow-bulk')
  const needsConfirm = slow.length > 0 || forceConfirm
  const hasEntry = !!state.config.steps?.[step]

  // Ask each harness in the draft for the models it lists, once.
  const harnessIds = [draft.primary.harness, draft.fallback.harness]
  useEffect(() => {
    for (const id of harnessIds) {
      const info = state.harnesses.find((h) => h.id === id)
      if (!info?.modelSelectable || models[id]) continue
      void window.electronAPI.pipeline
        .listModels({ harness: id })
        .then((list) => setModels((prev) => ({ ...prev, [id]: list })))
        .catch(() => setModels((prev) => ({ ...prev, [id]: [] })))
    }
    // models is read only to skip a harness already asked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessIds.join('|'), state.harnesses])

  const change = (patch: Partial<StepDraftFields>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    setRefused([])
  }

  const send = async (nextPrimary: typeof primary, nextFallback: typeof fallback) => {
    setSaving(true)
    try {
      const result = await window.electronAPI.pipeline.saveStep({
        step,
        primary: nextPrimary,
        fallback: nextFallback,
        confirmSlow: needsConfirm && confirmed
      })
      if (result.success) {
        toast.success(`${meta.label} saved.`)
        onSaved()
        return
      }
      if (result.needsConfirmation) setForceConfirm(true)
      if (result.error) toast.error(`Could not save: ${result.error}`)
      setRefused(result.issues?.filter((i) => i.severity === 'error') ?? [])
    } catch (e) {
      toast.error(`Could not save: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const shown = [...errors, ...refused.filter((r) => !errors.some((e) => e.message === r.message))]

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4" role="group" aria-label={`Edit ${meta.label}`}>
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <ChoiceFields
          idPrefix={`${step}-main`}
          label="Main choice"
          allowNone={false}
          harnesses={state.harnesses}
          value={draft.primary}
          models={models[draft.primary.harness] ?? []}
          onChange={(primaryFields: Fields) => change({ primary: primaryFields })}
          autoFocus
        />
        <ChoiceFields
          idPrefix={`${step}-fallback`}
          label="Fallback"
          allowNone
          harnesses={state.harnesses}
          value={draft.fallback}
          models={models[draft.fallback.harness] ?? []}
          onChange={(fallbackFields: Fields) => change({ fallback: fallbackFields })}
        />
      </div>

      <p className="text-[13px] text-muted-foreground">
        The fallback runs only when the main choice fails or is not available. Nothing needs a restart: the next call uses what you save.
      </p>

      {shown.length > 0 && (
        <ul className="space-y-1" role="alert">
          {shown.map((issue) => (
            <li key={issue.message} className="text-sm text-destructive">
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {needsConfirm && (
        <div className="space-y-2">
          <p className="text-sm">
            {slow[0]?.message ?? `This harness takes seconds per call and ${meta.label} runs once per recording.`}
          </p>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" className="h-4 w-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I understand each call takes seconds
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={saving || errors.length > 0 || (needsConfirm && !confirmed)} onClick={() => void send(primary, fallback)}>
          Save
        </Button>
        <Button variant="outline" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        {hasEntry && (
          <Button variant="ghost" disabled={saving} onClick={() => void send(AUTO_PROFILE, null)}>
            Use Automatic
          </Button>
        )}
      </div>
    </div>
  )
}
