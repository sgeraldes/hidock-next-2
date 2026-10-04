import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/toaster'
import { DECISION_ENGINE_IDS, DECISION_PRESETS, DECISION_STEPS, type DecisionConfig, type DecisionPreset, type DecisionStep, type PipelineSettingsState } from '@/shared/pipeline-config'
import { SELECT_CLASS } from './ChoiceFields'

const PRESET_LABELS: Record<DecisionPreset, string> = {
  'zero-cost': 'Zero cost', cheapest: 'Cheapest', 'most-accurate': 'Most accurate', fastest: 'Fastest'
}
const STEP_LABELS: Record<DecisionStep, string> = {
  'identity-tiebreak': 'Identity tiebreak', 'meeting-match': 'Meeting match', evaluate: 'Evaluation',
  'sample-compare': 'Sample comparison', 'kind-pick': 'Recording kind'
}
const ENGINE_LABELS = { 'clef-flash': 'Clef Flash', clef: 'Clef', jev: 'Jev', haiku: 'Claude Haiku', 'gemini-flash': 'Gemini Flash' }

export function Decisions({ state, onSaved }: { state: PipelineSettingsState; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<DecisionConfig>(state.config.decisions ?? { preset: 'zero-cost', overrides: {} })
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    try {
      const result = await window.electronAPI.pipeline.saveDecisions(draft)
      if (!result.success) throw new Error(result.error ?? 'Could not save.')
      await onSaved()
      toast.success('Decisions saved.')
    } catch (error) {
      toast.error(`Could not save decisions: ${error instanceof Error ? error.message : String(error)}`)
    } finally { setSaving(false) }
  }
  return (
    <section aria-labelledby="pipeline-decisions" className="space-y-3">
      <h3 id="pipeline-decisions" className="text-sm font-semibold">Decisions</h3>
      <p className="text-sm text-muted-foreground">Choose how decisions are made. If an engine cannot answer, the preset tries the next one.</p>
      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <Label htmlFor="decision-preset">Global preset</Label>
          <select id="decision-preset" className={SELECT_CLASS} value={draft.preset} disabled={saving}
            onChange={event => setDraft({ ...draft, preset: event.target.value as DecisionPreset })}>
            {DECISION_PRESETS.map(preset => <option key={preset} value={preset}>{PRESET_LABELS[preset]}</option>)}
          </select>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {DECISION_STEPS.map(step => (
            <div key={step} className="space-y-1">
              <Label htmlFor={`decision-${step}`}>{STEP_LABELS[step]}</Label>
              <select id={`decision-${step}`} className={SELECT_CLASS} value={draft.overrides[step] ?? ''} disabled={saving}
                onChange={event => {
                  const overrides = { ...draft.overrides }
                  if (event.target.value) overrides[step] = event.target.value as DecisionConfig['overrides'][DecisionStep]
                  else delete overrides[step]
                  setDraft({ ...draft, overrides })
                }}>
                <option value="">Same as preset</option>
                {DECISION_PRESETS.map(preset => <option key={preset} value={preset}>{PRESET_LABELS[preset]}</option>)}
                {DECISION_ENGINE_IDS.map(engine => <option key={engine} value={engine}>{ENGINE_LABELS[engine]}</option>)}
              </select>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Estimated cost per call with 4,000 input tokens and 200 output tokens. Actual billing depends on usage.</p>
        <ul className="space-y-1 text-sm">
          {(state.decisionEngines ?? []).map(engine => (
            <li key={engine.id}>{engine.label} · {engine.available ? 'Available' : 'Unavailable'} · {engine.costPerCallUsd === null ? 'Unknown cost' : `US$ ${engine.costPerCallUsd}`} · {engine.dataLeavesMachine === 'lan' ? 'Local network' : 'Cloud'}</li>
          ))}
        </ul>
        <Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save decisions'}</Button>
      </div>
    </section>
  )
}
