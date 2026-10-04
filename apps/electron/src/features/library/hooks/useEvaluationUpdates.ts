/**
 * Put a recording's evaluation (stars, kind, work or personal) on its Library
 * row the moment it is saved.
 *
 * The row refreshes once when its transcription finishes; the evaluation is
 * saved minutes later, so rows showed no chip until the next full refresh
 * (owner, 2-oct-2026). The main process announces each saved evaluation as an
 * `evaluation:saved` domain event; this hook collects them and applies them to
 * the store in one update every EVALUATION_FLUSH_MS, so an overnight batch of
 * hundreds re-renders the list a few times, not hundreds.
 */

import { useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'
import type { UnifiedRecording } from '@/types/unified-recording'

export const EVALUATION_FLUSH_MS = 250

interface EvaluationSavedPayload {
  recordingId: string
  starLevel?: number | null
  kind?: string | null
  context?: string | null
  audioWarning?: string | null
}

function fieldsOf(p: EvaluationSavedPayload): Partial<UnifiedRecording> {
  return {
    evalStarLevel: p.starLevel ?? undefined,
    evalKind: (p.kind ?? undefined) as UnifiedRecording['evalKind'],
    evalContext: (p.context ?? undefined) as UnifiedRecording['evalContext'],
    evalAudioWarning: (p.audioWarning ?? undefined) as UnifiedRecording['evalAudioWarning']
  }
}

/** Mount once, on the Library page. */
export function useEvaluationUpdates(): void {
  useEffect(() => {
    const onDomainEvent = window.electronAPI?.onDomainEvent
    if (!onDomainEvent) return

    const pending = new Map<string, EvaluationSavedPayload>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      timer = null
      if (pending.size === 0) return
      const { unifiedRecordings, setUnifiedRecordings } = useAppStore.getState()
      let changed = false
      const next = unifiedRecordings.map((recording) => {
        const update = pending.get(recording.id)
        if (!update) return recording
        changed = true
        return { ...recording, ...fieldsOf(update) } as UnifiedRecording
      })
      pending.clear()
      if (changed) setUnifiedRecordings(next)
    }

    const unsubscribe = onDomainEvent((event: { type?: string; payload?: unknown }) => {
      if (event?.type !== 'evaluation:saved') return
      const payload = event.payload as Partial<EvaluationSavedPayload> | undefined
      if (!payload?.recordingId) return
      pending.set(payload.recordingId, payload as EvaluationSavedPayload)
      if (!timer) timer = setTimeout(flush, EVALUATION_FLUSH_MS)
    })

    return () => {
      unsubscribe?.()
      if (timer) clearTimeout(timer)
    }
  }, [])
}
