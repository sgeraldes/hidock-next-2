/**
 * One line saying what the Model Host is doing: working, testing the voice model, not answering
 * (paused, in use or off), and so on. Shown in Settings > Transcription > Model host and in the
 * voice evidence panel, so the person can tell why speaker work is running here without opening
 * the gamestation. When the host ran the model on its CPU although it has a GPU, it offers Repair:
 * HiDock asks the host to reinstall the CUDA build of torch.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  cpuDespiteGpu,
  describeModelHost,
  type ModelHostSentence,
  type ModelHostStatus
} from '@/shared/model-host-status'

/** The host's own health answer is cached for 15 s in the main process; asking faster adds nothing. */
export const MODEL_HOST_STATUS_POLL_MS = 15_000

const TONE_CLASS: Record<ModelHostSentence['tone'], string> = {
  none: 'text-muted-foreground',
  working: 'text-emerald-700 dark:text-emerald-400',
  paused: 'text-amber-800 dark:text-amber-300',
  off: 'text-muted-foreground'
}

export function ModelHostStatusLine({ hideWhenNone = false }: { hideWhenNone?: boolean }) {
  const [status, setStatus] = useState<ModelHostStatus | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)

  const ask = useCallback(async () => {
    const api = window.electronAPI?.modelHost
    if (!api?.status) return
    try {
      const result = await api.status()
      if (result?.success) setStatus(result.status)
    } catch {
      // The line keeps what it last knew; the next poll asks again.
    }
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.modelHost?.status) return
    let alive = true
    const tick = () => {
      if (alive) void ask()
    }
    tick()
    const timer = setInterval(tick, MODEL_HOST_STATUS_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [ask])

  const repair = async () => {
    setRepairing(true)
    setRepairError(null)
    try {
      const result = await window.electronAPI.modelHost.repair()
      if (!result.success) setRepairError(result.error ?? 'The host did not take the repair.')
      await ask()
    } finally {
      setRepairing(false)
    }
  }

  if (!status) return null
  if (hideWhenNone && !status.configured) return null
  const sentence = describeModelHost(status)
  const offerRepair = status.paired && cpuDespiteGpu(status.health)
  return (
    <div className="space-y-1">
      <p role="status" data-tone={sentence.tone} className={`text-xs ${TONE_CLASS[sentence.tone]}`}>
        {sentence.text}
        {offerRepair && (
          <button
            type="button"
            className="ml-2 underline underline-offset-2 disabled:opacity-60"
            onClick={() => void repair()}
            disabled={repairing}
          >
            Repair
          </button>
        )}
      </p>
      {repairError && (
        <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
          {repairError}
        </p>
      )}
    </div>
  )
}
