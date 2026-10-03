/**
 * Settings > Speakers & voices: voice evidence for recordings transcribed before voices were
 * measured (spec 2026-10-03, section 1b). The schedule, the night window, the progress, the
 * last problem, and a button that measures one recording now so the rest can be estimated.
 * Where it runs is the speaker engine chosen above; this only says when.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { BusyIcon, WorkingBar, WorkingValue } from '@/components/ui/working'
import { toast } from '@/components/ui/toaster'
import { appLocale } from '@/lib/locale'
import { useConfigStore } from '@/store/domain/useConfigStore'
import {
  DEFAULT_VOICE_BACKFILL,
  type VoiceBackfillConfig,
  type VoiceBackfillMeasure,
  type VoiceBackfillSchedule,
  type VoiceBackfillStatus
} from '@/shared/voice-backfill-schedule'

const SCHEDULES: Array<{ value: VoiceBackfillSchedule; label: string }> = [
  { value: 'night', label: 'At night' },
  { value: 'background', label: 'In the background' },
  { value: 'off', label: 'Off' }
]

/** "1 h", "13 h 20 min", "1 min 30 s", "45 s". */
export function spokenDuration(totalSeconds: number): string {
  const rounded = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const seconds = rounded % 60
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`
  return `${seconds} s`
}

const count = (n: number) => n.toLocaleString(appLocale())

function measureSentence(measure: VoiceBackfillMeasure, remainingAudioSeconds: number): string {
  const where = measure.device ? ` on ${measure.device}` : ''
  const took = `${spokenDuration(measure.audioSeconds)} of audio took ${spokenDuration(measure.seconds)}${where}.`
  if (measure.audioSeconds <= 0) return took
  const estimate = remainingAudioSeconds * (measure.seconds / measure.audioSeconds)
  return `${took} The rest would take about ${spokenDuration(estimate)}.`
}

export function VoiceBackfillPanel() {
  const configured = useConfigStore((s) => s.config?.transcription?.voiceBackfill)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const schedule: VoiceBackfillConfig = { ...DEFAULT_VOICE_BACKFILL, ...(configured ?? {}) }
  const [status, setStatus] = useState<VoiceBackfillStatus | null>(null)
  const [measure, setMeasure] = useState<VoiceBackfillMeasure | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measureError, setMeasureError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI?.voiceBackfill?.getStatus()
      if (result?.success) setStatus(result.data)
    } catch {
      // The panel keeps the last numbers it had; the next progress event tries again.
    }
  }, [])

  useEffect(() => {
    void refresh()
    const api = window.electronAPI as { onDomainEvent?: (cb: (e: { type?: string }) => void) => () => void } | undefined
    if (!api?.onDomainEvent) return
    return api.onDomainEvent((event) => {
      if (event?.type === 'voice-backfill:progress') void refresh()
    })
  }, [refresh])

  const save = (next: Partial<VoiceBackfillConfig>) => {
    void updateConfig('transcription', { voiceBackfill: { ...schedule, ...next } } as never).catch((err: unknown) =>
      toast.error('Could not change when voice evidence is computed', err instanceof Error ? err.message : undefined)
    )
  }

  const saveTime = (key: 'windowStart' | 'windowEnd', value: string) => {
    if (/^\d{2}:\d{2}$/.test(value)) save({ [key]: value })
  }

  const measureNow = async () => {
    setMeasuring(true)
    setMeasureError(null)
    try {
      const result = await window.electronAPI.voiceBackfill.measureOne()
      if (result.success) setMeasure(result.data)
      else setMeasureError(result.error.message)
    } catch (err) {
      setMeasureError(err instanceof Error ? err.message : 'The measurement failed.')
    } finally {
      setMeasuring(false)
      void refresh()
    }
  }

  const shownMeasure = measure ?? status?.lastMeasure ?? null
  const rest = status
    ? [
        status.remaining > 0
          ? `${count(status.remaining)} to go (${spokenDuration(status.remainingAudioSeconds)} of audio)`
          : 'Nothing left to measure',
        status.failed > 0 ? `${count(status.failed)} failed` : null,
        status.skipped > 0 ? `${count(status.skipped)} with no voice long enough` : null
      ]
        .filter(Boolean)
        .join(', ') + '.'
    : null

  return (
    <section aria-labelledby="voice-backfill-heading" className="space-y-3 rounded-xl bg-muted/45 p-4 shadow-sm" data-testid="voice-backfill">
      <div>
        <h3 id="voice-backfill-heading" className="text-sm font-semibold">
          Voice evidence for older recordings
        </h3>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          Recordings transcribed before voices were measured get their voices here, one at a time, at low priority. It
          runs where the speaker engine above runs and waits while a recording is transcribed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="voiceBackfillSchedule" className="sr-only">
          When to compute voice evidence
        </label>
        <select
          id="voiceBackfillSchedule"
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={schedule.schedule}
          onChange={(e) => save({ schedule: e.target.value as VoiceBackfillSchedule })}
        >
          {SCHEDULES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {schedule.schedule === 'night' && (
          <>
            <label htmlFor="voiceBackfillStart" className="text-sm">
              Starts at
            </label>
            <input
              id="voiceBackfillStart"
              type="time"
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={schedule.windowStart}
              onChange={(e) => saveTime('windowStart', e.target.value)}
            />
            <label htmlFor="voiceBackfillEnd" className="text-sm">
              Ends at
            </label>
            <input
              id="voiceBackfillEnd"
              type="time"
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={schedule.windowEnd}
              onChange={(e) => saveTime('windowEnd', e.target.value)}
            />
          </>
        )}
      </div>

      <div className="space-y-1 text-sm">
        {status ? (
          <>
            <p>
              {count(status.done)} of {count(status.total)} recordings have voice evidence.
            </p>
            <p className="text-xs text-muted-foreground">{rest}</p>
            {status.lastError && <p className="text-xs text-amber-800 dark:text-amber-300">Last problem: {status.lastError}</p>}
            {status.running && !measuring && <WorkingBar label="Measuring a recording now" />}
          </>
        ) : (
          <WorkingValue label="Counting recordings" className="w-48" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void measureNow()}
          disabled={measuring}
          aria-busy={measuring || undefined}
          title={measuring ? 'Measuring' : undefined}
        >
          {measuring && <BusyIcon className="mr-2" />}
          Measure one recording
        </Button>
        {shownMeasure && !measuring && (
          <p className="text-xs text-muted-foreground">{measureSentence(shownMeasure, status?.remainingAudioSeconds ?? 0)}</p>
        )}
      </div>
      {measureError && (
        <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
          {measureError}
        </p>
      )}
    </section>
  )
}
