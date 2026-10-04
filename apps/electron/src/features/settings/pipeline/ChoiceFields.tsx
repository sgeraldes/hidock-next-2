import { EFFORT_LEVELS, AUTO_PROFILE, type HarnessState, type ModelOption } from '@/shared/pipeline-config'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { ChoiceFields as Fields } from './describe'

/** A native select in the look of the kit's Input: it works with the keyboard and in a test without a popover. */
export const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

interface Props {
  /** Prefix of the element ids, unique on the page: the step and the role of the choice. */
  idPrefix: string
  /** `Main choice` or `Fallback`; the model and effort are labelled from it. */
  label: string
  /** Offer "None" as the first option (the fallback may be absent; the main choice may not). */
  allowNone: boolean
  harnesses: readonly HarnessState[]
  value: Fields
  models: readonly ModelOption[]
  onChange: (next: Fields) => void
  autoFocus?: boolean
}

function optionText(h: HarnessState): string {
  return h.available ? h.label : `${h.label} — ${h.reason ?? 'not available'}`
}

/**
 * One choice of a step: the harness, then the model and the effort when that harness takes them. Changing
 * the harness empties the model and the effort, because a name from one harness means nothing to another.
 */
export function ChoiceFields({ idPrefix, label, allowNone, harnesses, value, models, onChange, autoFocus }: Props) {
  const info = harnesses.find((h) => h.id === value.harness)
  const prefix = label === 'Main choice' ? '' : `${label} `
  const modelLabel = `${prefix}${prefix ? 'model' : 'Model'}`
  const effortLabel = `${prefix}${prefix ? 'effort' : 'Effort'}`
  const listId = `${idPrefix}-models`

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-harness`} className="text-sm font-medium">
          {label}
        </Label>
        <select
          id={`${idPrefix}-harness`}
          className={SELECT_CLASS}
          value={value.harness}
          autoFocus={autoFocus}
          onChange={(e) => onChange({ harness: e.target.value, model: '', effort: '' })}
        >
          {allowNone && <option value="">None</option>}
          <option value={AUTO_PROFILE}>Automatic</option>
          {harnesses.map((h) => (
            <option key={h.id} value={h.id} disabled={!h.available}>
              {optionText(h)}
            </option>
          ))}
        </select>
      </div>

      {info?.modelSelectable && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-model`} className="text-sm font-medium">
            {modelLabel}
          </Label>
          <Input
            id={`${idPrefix}-model`}
            list={listId}
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id={listId}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
          </datalist>
          <p className="text-[13px] text-muted-foreground">Pick one or type a name. Empty uses the default of {info.label}.</p>
        </div>
      )}

      {info?.effortLevels && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-effort`} className="text-sm font-medium">
            {effortLabel}
          </Label>
          <select
            id={`${idPrefix}-effort`}
            className={cn(SELECT_CLASS)}
            value={value.effort}
            onChange={(e) => onChange({ ...value, effort: e.target.value as Fields['effort'] })}
          >
            <option value="">Default</option>
            {EFFORT_LEVELS.filter((level) => info.effortLevels?.includes(level)).map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
