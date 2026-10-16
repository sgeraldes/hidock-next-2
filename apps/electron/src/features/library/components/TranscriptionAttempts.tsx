import { useEffect, useState } from 'react'
import { engineOptionLabel, type TranscriptionAttemptView } from '@/shared/transcription-engines'

const OUTCOME_TEXT: Record<TranscriptionAttemptView['outcome'], string> = {
  succeeded: 'worked',
  failed: 'failed',
  'skipped-unavailable': 'skipped, unavailable',
}

/** 'configured:gemini' reads as the default service it ran; other entries use the Settings label. */
function engineName(engine: string): string {
  const configured = /^configured:(.+)$/.exec(engine)
  return configured ? `Default service (${configured[1]})` : engineOptionLabel(engine)
}

/**
 * Every engine the transcription tried, with the reason each one failed or was
 * skipped (16-oct-2026). Shown under a failed recording so the owner sees what
 * was tried before the error, without opening the logs.
 */
export function TranscriptionAttempts({ recordingId, refreshKey }: { recordingId: string; refreshKey?: unknown }) {
  const [attempts, setAttempts] = useState<TranscriptionAttemptView[]>([])
  useEffect(() => {
    let live = true
    const api = window.electronAPI?.recordings
    api?.getTranscriptionAttempts?.(recordingId).then((rows) => { if (live) setAttempts(rows ?? []) }, () => { if (live) setAttempts([]) })
    return () => { live = false }
  }, [recordingId, refreshKey])
  if (!attempts.length) return null
  return (
    <details className="text-xs" data-testid="transcription-attempts">
      <summary className="cursor-pointer text-muted-foreground">
        {attempts.length === 1 ? '1 attempt' : `${attempts.length} attempts`}
      </summary>
      <ol className="mt-1 space-y-0.5">
        {attempts.map((attempt, index) => (
          <li key={`${attempt.startedAt}-${index}`}>
            <span className="text-muted-foreground">{new Date(attempt.startedAt).toLocaleTimeString()}</span>{' '}
            {engineName(attempt.engine)}{attempt.attempt > 1 ? ` (try ${attempt.attempt})` : ''}: {OUTCOME_TEXT[attempt.outcome]}
            {attempt.waitedSeconds > 0 ? ` after waiting ${attempt.waitedSeconds} s` : ''}
            {attempt.message && attempt.outcome !== 'succeeded' ? <span className="text-muted-foreground"> · {attempt.message}</span> : null}
          </li>
        ))}
      </ol>
    </details>
  )
}
