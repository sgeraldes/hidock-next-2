/**
 * Speakers & voices: which engine does voice recognition on this hardware.
 *
 * Shown as a dialog when a GPU is added or removed (never on an ordinary
 * launch), and in Settings. One option is recommended for the detected
 * hardware. Turning voice recognition off is possible, never the default, and
 * sits behind a red warning and a second confirmation.
 *
 * Spec: docs/superpowers/specs/2026-09-24-speaker-engines-design.md
 */

import { useEffect, useState } from 'react'
import { AlertOctagon, Cpu, MonitorSmartphone, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import type { SpeakerEngineId, SpeakerSetup, SpeakerSetupOption } from '@/types/speakers'

export const VOICE_OFF_WARNING =
  'Voice recognition is what lets HiDock name the people in your recordings. With it off, speakers stay ' +
  '"Speaker 1, Speaker 2" in every recording, known people are no longer named automatically, and voices ' +
  'you already identified stop being matched.'

function speedText(option: SpeakerSetupOption): string | null {
  if (!option.measuredSpeedRatio) return null
  const minutesPerHour = Math.round(option.measuredSpeedRatio * 60)
  return `Measured on this computer: about ${minutesPerHour} min per hour of audio.`
}

interface SpeakerSetupPanelProps {
  /** The setup already loaded (the dialog has it); the panel loads its own otherwise. */
  initial?: SpeakerSetup
  /** Called after the owner saved a choice. */
  onSaved?: (setup: SpeakerSetup) => void
}

export function SpeakerSetupPanel({ initial, onSaved }: SpeakerSetupPanelProps): React.ReactElement {
  const [setup, setSetup] = useState<SpeakerSetup | null>(initial ?? null)
  const [selected, setSelected] = useState<SpeakerEngineId | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const load = async (refresh = false) => {
    setBusy(true)
    setFailure(null)
    try {
      const result = await window.electronAPI.speakers.getSetup({ refresh })
      if (!result.success) setFailure(result.error.message)
      else setSetup(result.data)
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not read the hardware')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!initial) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!setup || selected) return
    // Voice recognition that is off stays off unless the owner picks an engine:
    // preselecting the recommendation would turn it back on with one click.
    if (setup.effectiveEngine === 'off') {
      setSelected('off')
      setConfirmOff(true)
      return
    }
    // Preselect the current engine when the owner already chose one on this
    // hardware; otherwise the recommendation.
    const current = setup.options.find((o) => o.engine === setup.configuredEngine && o.available)
    const recommended = setup.options.find((o) => o.recommended)
    setSelected(!setup.needsConfirmation && current ? current.engine : recommended?.engine ?? null)
  }, [setup, selected])

  if (!setup) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="speaker-setup-loading">
        {failure ? `Could not read the hardware: ${failure}` : 'Reading the hardware…'}
      </div>
    )
  }

  const chosen = setup.options.find((o) => o.engine === selected)
  const turningOff = selected === 'off'

  const save = async () => {
    if (!selected) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await window.electronAPI.speakers.applySetup({
        engine: selected,
        fingerprint: setup.fingerprint,
        confirmOff: turningOff ? confirmOff : undefined,
      })
      if (!result.success) {
        setFailure(result.error.message)
        return
      }
      setSetup(result.data)
      toast.success(turningOff ? 'Voice recognition is off' : `Voice recognition: ${chosen?.label ?? selected}`)
      onSaved?.(result.data)
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="speaker-setup">
      <div className="space-y-1 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <MonitorSmartphone className="h-4 w-4" aria-hidden="true" />
          {setup.profileSummary}
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Cpu className="h-4 w-4" aria-hidden="true" />
          {setup.hardware.cpu.model} · {setup.hardware.cpu.logicalCores} threads
        </div>
        {setup.detectionFailed && (
          <p className="text-amber-600 dark:text-amber-400">
            The GPUs could not be read, so these options may not fit this computer.
          </p>
        )}
        {setup.voiceSpace && (
          <p className="text-muted-foreground">
            Your library knows {setup.voiceSpace.clusters} voices, {setup.voiceSpace.anchored} of them linked to people.
            Every option here keeps using the model they were built with, so they keep being recognized.
            {setup.voiceSpace.otherModelClusters > 0 &&
              ` ${setup.voiceSpace.otherModelClusters} more voices (${setup.voiceSpace.otherModelAnchored} linked to people) ` +
                'come from another voice model and are not matched until they are transferred.'}
          </p>
        )}
      </div>

      <div role="radiogroup" aria-label="Voice recognition engine" className="space-y-2">
        {setup.options.map((option) => {
          const isSelected = option.engine === selected
          const isOff = option.engine === 'off'
          return (
            <label
              key={option.engine}
              className={`block rounded-md border p-3 text-sm ${
                option.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
              } ${isSelected ? (isOff ? 'border-red-500 bg-red-500/5' : 'border-primary bg-primary/5') : ''}`}
              data-testid={`speaker-option-${option.engine}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="speaker-engine"
                  className="mt-1"
                  value={option.engine}
                  checked={isSelected}
                  disabled={!option.available}
                  onChange={() => {
                    setSelected(option.engine)
                    setConfirmOff(false)
                  }}
                />
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    <span className={isOff ? 'text-red-600 dark:text-red-400' : ''}>{option.label}</span>
                    {option.recommended && (
                      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">Recommended</span>
                    )}
                    {option.idealForHardware && !option.available && (
                      <span className="rounded-full border px-2 py-0.5 text-xs">Best for this hardware</span>
                    )}
                    <span className="text-xs text-muted-foreground">{option.where}</span>
                  </div>
                  <p className="text-muted-foreground">{option.description}</p>
                  {speedText(option) && <p className="text-xs text-muted-foreground">{speedText(option)}</p>}
                  {!option.available && option.unavailableReason && (
                    <p className="text-xs text-muted-foreground">{option.unavailableReason}</p>
                  )}
                </div>
              </div>
            </label>
          )
        })}
      </div>

      {turningOff && (
        <div className="space-y-3 rounded-md border-2 border-red-600 bg-red-600/10 p-4" role="alert" data-testid="voice-off-warning">
          <div className="flex items-start gap-2 text-red-700 dark:text-red-300">
            <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="font-semibold">{VOICE_OFF_WARNING}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmOff} onChange={(e) => setConfirmOff(e.target.checked)} />
            I understand, and I want voice recognition off on this computer.
          </label>
        </div>
      )}

      {failure && <p className="text-sm text-destructive">{failure}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => void save()}
          disabled={busy || !selected || (turningOff && !confirmOff)}
          variant={turningOff ? 'destructive' : 'default'}
        >
          {turningOff ? 'Turn voice recognition off' : 'Use this'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={busy}>
          <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" /> Detect again
        </Button>
        {setup.lastConfirmedAt && (
          <span className="text-xs text-muted-foreground">
            Last confirmed {new Date(setup.lastConfirmedAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  )
}
