import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/toaster'
import { DECISION_ENGINE_IDS, DECISION_PRESETS, DECISION_STEPS, type DecisionConfig, type DecisionPreset, type DecisionStep, type PipelineSettingsState } from '@/shared/pipeline-config'
import { SELECT_CLASS } from './ChoiceFields'

const PRESET_LABELS: Record<DecisionPreset, string> = {
  'zero-cost': 'Costo cero', cheapest: 'El más barato', 'most-accurate': 'El más preciso', fastest: 'El más rápido'
}
const STEP_LABELS: Record<DecisionStep, string> = {
  'identity-tiebreak': 'Desempate de identidad', 'meeting-match': 'Coincidencia con reunión', evaluate: 'Evaluación',
  'sample-compare': 'Comparación de muestras', 'kind-pick': 'Tipo de grabación'
}
const ENGINE_LABELS = { 'clef-flash': 'Clef Flash', clef: 'Clef', jev: 'Jev', haiku: 'Claude Haiku', 'gemini-flash': 'Gemini Flash' }

export function Decisions({ state, onSaved }: { state: PipelineSettingsState; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<DecisionConfig>(state.config.decisions ?? { preset: 'zero-cost', overrides: {} })
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    try {
      const result = await window.electronAPI.pipeline.saveDecisions(draft)
      if (!result.success) throw new Error(result.error ?? 'No se pudo guardar.')
      await onSaved()
      toast.success('Decisiones guardadas.')
    } catch (error) {
      toast.error(`No se pudieron guardar las decisiones: ${error instanceof Error ? error.message : String(error)}`)
    } finally { setSaving(false) }
  }
  return (
    <section aria-labelledby="pipeline-decisions" className="space-y-3">
      <h3 id="pipeline-decisions" className="text-sm font-semibold">Decisiones</h3>
      <p className="text-sm text-muted-foreground">Elegí cómo resolver las decisiones. Si un motor no puede responder, el preset prueba el siguiente.</p>
      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <Label htmlFor="decision-preset">Preset global</Label>
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
                <option value="">Como el preset</option>
                {DECISION_PRESETS.map(preset => <option key={preset} value={preset}>{PRESET_LABELS[preset]}</option>)}
                {DECISION_ENGINE_IDS.map(engine => <option key={engine} value={engine}>{ENGINE_LABELS[engine]}</option>)}
              </select>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Costo estimado por llamada con 4.000 tokens de entrada y 200 de salida. La facturación real depende del uso.</p>
        <ul className="space-y-1 text-sm">
          {(state.decisionEngines ?? []).map(engine => (
            <li key={engine.id}>{engine.label} · {engine.available ? 'Disponible' : 'No disponible'} · {engine.costPerCallUsd === null ? 'Costo desconocido' : `US$ ${engine.costPerCallUsd}`} · {engine.dataLeavesMachine === 'lan' ? 'Red local' : 'Nube'}</li>
          ))}
        </ul>
        <Button onClick={() => void save()} disabled={saving}>{saving ? 'Guardando…' : 'Guardar decisiones'}</Button>
      </div>
    </section>
  )
}
