import { Cloud, HardDrive, Pencil, Route } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  STEP_META,
  issuesForStep,
  validatePipelineConfig,
  type PipelineSettingsState,
  type TextStepId
} from '@/shared/pipeline-config'
import { describePlan, formatStats, privacyLabel } from './describe'
import { StepEditor } from './StepEditor'

interface Props {
  step: TextStepId
  state: PipelineSettingsState
  editing: boolean
  onEdit: () => void
  onClose: () => void
  onSaved: () => void
}

function PrivacyIcon({ label }: { label: string }) {
  const className = 'h-3.5 w-3.5 shrink-0'
  if (label.startsWith('Stays')) return <HardDrive className={className} aria-hidden="true" />
  if (label.startsWith('Sent')) return <Cloud className={className} aria-hidden="true" />
  return <Route className={className} aria-hidden="true" />
}

/**
 * One step: what it is, what it runs on, where its text goes, how it has done in the last 30 days, and the
 * editor when it is open. A saved plan the app cannot run says so here, with the reason, because the step
 * runs as Automatic until it is fixed.
 */
export function StepRow({ step, state, editing, onEdit, onClose, onSaved }: Props) {
  const meta = STEP_META[step]
  const privacy = privacyLabel(state.config, step, state.harnesses)
  const ignored = issuesForStep(state.config, validatePipelineConfig(state.config, state.harnesses), step).filter(
    (i) => i.severity === 'error'
  )

  return (
    <li className="px-4 py-3" data-testid={`step-${step}`}>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <p className="text-sm font-medium">{meta.label}</p>
          <p className="text-[13px] text-muted-foreground">{meta.description}</p>
        </div>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm">{describePlan(state.config, step, state.harnesses)}</p>
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <PrivacyIcon label={privacy} />
            {privacy}
          </p>
          <p className="text-[13px] tabular-nums text-muted-foreground">{formatStats(state.stats[step])}</p>
        </div>
        {/* Kept in place (hidden) while the editor is open, so the columns do not move. */}
        <Button
          variant="outline"
          size="sm"
          className={cn('justify-self-start text-[13px] md:justify-self-end', editing && 'invisible')}
          onClick={onEdit}
          aria-label={`Edit ${meta.label}`}
          aria-hidden={editing}
          disabled={editing}
          tabIndex={editing ? -1 : undefined}
        >
          <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Edit
        </Button>
      </div>

      {ignored.length > 0 && (
        <p className="mt-2 text-sm text-destructive">
          This plan is ignored and the step runs as Automatic: {ignored[0].message}
        </p>
      )}

      {editing && <StepEditor step={step} state={state} onClose={onClose} onSaved={onSaved} />}
    </li>
  )
}
