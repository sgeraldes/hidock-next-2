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
import { VALIDITY_LABELS, formatTranscriptionCost, heldValidity, validityReasons } from '@/features/library/utils/transcriptValidity'
import { isJumpableLineIssue, type LineIssueCode } from '@/shared/transcript-line-issues'
import { appLocale } from '@/lib/locale'

interface TranscriptIntegrityPanelProps {
  recordingId: string
  transcript: Pick<Transcript, 'integrity_status' | 'integrity_json' | 'integrity_accepted_at'> &
    Partial<Pick<Transcript, 'validity_status' | 'validity_json'>>
  /** Length of the recording, for the cost of transcribing it again. */
  durationSeconds?: number
  /** Queue a new transcription; absent when transcription is unavailable. */
  onRetranscribe?: () => void
  /** Called after the owner accepted or un-accepted, so the caller can reload. */
  onChanged?: () => void
  /** Go to the next line with this problem in the transcript below. */
  onJump?: (code: LineIssueCode) => void
}

export function TranscriptIntegrityPanel({ recordingId, transcript, durationSeconds, onRetranscribe, onChanged, onJump }: TranscriptIntegrityPanelProps) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const label = integrityLabel(transcript)
  const held = label === 'broken' ? null : heldValidity(transcript)
  const retranscribeLabel = durationSeconds ? `Transcribe again (${formatTranscriptionCost(durationSeconds)})` : 'Transcribe again'
  if ((label === 'ok' || label === 'unchecked') && !held) return null
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

  // The validity verdict, when the integrity check itself found nothing to say.
  if ((label === 'ok' || label === 'unchecked') && held) {
    const { label: heading, detail } = VALIDITY_LABELS[held]
    const reasons = validityReasons(transcript)
    const red = held === 'invalid'
    const ValidityIcon = red ? XOctagon : AlertTriangle
    return (
      <div
        className={`mb-3 space-y-2 rounded-md border px-3 py-2 text-xs ${red ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}
        data-testid="transcript-validity"
        data-validity={held}
        role="status"
      >
        <div className="flex items-start gap-2">
          <ValidityIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${red ? 'text-red-600' : 'text-amber-600'}`} aria-hidden="true" />
          <div className="space-y-0.5">
            <p className="text-foreground">{heading}.</p>
            <p className="text-muted-foreground">{detail}</p>
          </div>
        </div>
        {reasons.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground" aria-label="Why">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {onRetranscribe && held !== 'doubtful' && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={onRetranscribe}>
              <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" /> {retranscribeLabel}
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

  if (label === 'accepted') {
    const when = transcript.integrity_accepted_at ? new Date(transcript.integrity_accepted_at).toLocaleDateString(appLocale()) : ''
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
        {issues.map((issue) => {
          const text = `${ISSUE_TAGS[issue.code]}${issue.count > 1 ? ` · ${issue.count}` : ''}`
          const code = issue.code
          return (
            <li key={code}>
              {onJump && isJumpableLineIssue(code) ? (
                <button
                  type="button"
                  title={`${issue.detail ?? ''}${issue.detail ? ' ' : ''}Click to go to the next one.`}
                  onClick={() => onJump(code)}
                  className="rounded-full border border-amber-500/50 bg-background px-2 py-0.5 hover:bg-amber-500/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`integrity-jump-${code}`}
                >
                  {text}
                </button>
              ) : (
                <span title={issue.detail} className="inline-block rounded-full border bg-background px-2 py-0.5">
                  {text}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {onRetranscribe && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={onRetranscribe}>
            <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" /> {retranscribeLabel}
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
