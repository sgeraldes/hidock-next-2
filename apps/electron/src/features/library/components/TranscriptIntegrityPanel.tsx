/**
 * What the integrity check found in this transcript, and the two ways back to
 * green: transcribe it again (the new transcript is checked when stored), or
 * accept it as it is. Renders nothing for a transcript that checked clean.
 */

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, RotateCcw, XOctagon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Transcript } from '@/types'
import { ISSUE_TAGS, integrityIssues, integrityLabel } from '@/features/library/utils/transcriptIntegrity'

interface TranscriptIntegrityPanelProps {
  recordingId: string
  transcript: Pick<Transcript, 'integrity_status' | 'integrity_json' | 'integrity_accepted_at'>
  /** Queue a new transcription; absent when transcription is unavailable. */
  onRetranscribe?: () => void
  /** Called after the owner accepted or un-accepted, so the caller can reload. */
  onChanged?: () => void
}

export function TranscriptIntegrityPanel({ recordingId, transcript, onRetranscribe, onChanged }: TranscriptIntegrityPanelProps) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const label = integrityLabel(transcript)
  if (label === 'ok' || label === 'unchecked') return null
  const issues = integrityIssues(transcript)

  const setAccepted = async (accepted: boolean) => {
    setBusy(true)
    setFailure(null)
    try {
      const result = await window.electronAPI.transcripts.setIntegrityAccepted({ recordingId, accepted })
      if (!result.success) setFailure(result.error.message)
      else onChanged?.()
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  if (label === 'accepted') {
    const when = transcript.integrity_accepted_at ? new Date(transcript.integrity_accepted_at).toLocaleDateString() : ''
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground" data-testid="transcript-integrity" data-integrity="accepted">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
        <span>
          Accepted as is{when ? ` on ${when}` : ''}, with {issues.length === 1 ? 'one problem' : `${issues.length} problems`} found in its timing.
        </span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void setAccepted(false)}>
          Undo
        </Button>
        {failure && <span className="text-destructive">{failure}</span>}
      </div>
    )
  }

  const broken = label === 'broken'
  const Icon = broken ? XOctagon : AlertTriangle
  return (
    <div
      className={`mb-3 space-y-2 rounded-md border px-3 py-2 text-xs ${broken ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}
      data-testid="transcript-integrity"
      data-integrity={label}
      role="status"
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${broken ? 'text-red-600' : 'text-amber-600'}`} aria-hidden="true" />
        <p className="text-foreground">
          {broken
            ? 'This transcript has more text than the recording can hold. Part of it was not said in this audio.'
            : 'The times in this transcript are wrong. The text may be right, but lines are out of place.'}
        </p>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Problems found">
        {issues.map((issue) => (
          <li key={issue.code} title={issue.detail} className="rounded-full border bg-background px-2 py-0.5">
            {ISSUE_TAGS[issue.code]}
            {issue.count > 1 ? ` · ${issue.count}` : ''}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {onRetranscribe && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={onRetranscribe}>
            <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" /> Transcribe again
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => void setAccepted(true)}>
          Accept as is
        </Button>
        {failure && <span className="text-destructive">{failure}</span>}
      </div>
    </div>
  )
}
