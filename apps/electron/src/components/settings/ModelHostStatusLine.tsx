/**
 * One line saying what the Model Host is doing: working, paused for a game (and which), paused by
 * hand, stopped, or off. Shown in Settings > Transcription > Model host and in the voice evidence
 * panel, so the person can tell why speaker work is running here without opening the gamestation.
 */
import { useEffect, useState } from 'react'
import { describeModelHost, type ModelHostSentence, type ModelHostStatus } from '@/shared/model-host-status'

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

  useEffect(() => {
    const api = window.electronAPI?.modelHost
    if (!api?.status) return
    let alive = true
    const ask = async () => {
      try {
        const result = await api.status()
        if (alive && result?.success) setStatus(result.status)
      } catch {
        // The line keeps what it last knew; the next poll asks again.
      }
    }
    void ask()
    const timer = setInterval(() => void ask(), MODEL_HOST_STATUS_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  if (!status) return null
  if (hideWhenNone && !status.configured) return null
  const sentence = describeModelHost(status)
  return (
    <p role="status" data-tone={sentence.tone} className={`text-xs ${TONE_CLASS[sentence.tone]}`}>
      {sentence.text}
    </p>
  )
}
