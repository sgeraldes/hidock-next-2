import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { readerTimingIssueLines } from '../utils/transcriptSegmentNavigation'
import { TIMING_CLASSIFICATION_LABELS, type TimingAssessment, type TimingReviewAction, type TimingSegment, type TimingSummaryResult } from '@/shared/transcript-timing'
import type { TranscriptContentUpdate } from './TranscriptViewer'

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const preciseClock = (seconds: number) => `${clock(seconds)}${Math.round((seconds % 1) * 10) ? `.${Math.round((seconds % 1) * 10)}` : ''}`

/** Fetched only for the open reader. Library verdict IPC stays small and text-free. */
export function useTranscriptTimingReview(recordingId: string | undefined, revision: string | null | undefined) {
  const [assessment, setAssessment] = useState<TimingAssessment | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    setAssessment(null)
    setFailure(null)
    const api = window.electronAPI?.transcripts?.getTiming
    if (!recordingId || !api) return
    void api({ recordingId }).then(result => {
      if (cancelled) return
      if (result.success) setAssessment(result.data)
      else setFailure(result.error.message)
    }).catch(err => { if (!cancelled) setFailure(err instanceof Error ? err.message : 'Could not check audio') })
    return () => { cancelled = true }
  }, [recordingId, revision, refresh])
  useEffect(() => { setSelected(null) }, [recordingId])
  return { assessment, failure, busy, selected, setSelected, setBusy, setFailure, reload: () => setRefresh(n => n + 1) }
}

type ReviewState = ReturnType<typeof useTranscriptTimingReview>
interface Props {
  recordingId: string
  segments?: TimingSegment[]
  pastAudioEnd?: boolean
  review: ReviewState
  onJump: (index: number) => void
  onUpdated: (update: TranscriptContentUpdate) => void
  onSummaryUpdated: (result: TimingSummaryResult) => void
}

export function TranscriptTimingReview({ recordingId, segments = [], pastAudioEnd, review, onJump, onUpdated, onSummaryUpdated }: Props) {
  const flagged = useMemo(() => readerTimingIssueLines(segments.map(s => ({ ...s, end: s.end ?? null })), pastAudioEnd)
    .flatMap((codes, index) => codes.length ? [index] : []), [segments, pastAudioEnd])
  const { assessment, busy, failure } = review
  const hidden = assessment?.hiddenIndices ?? segments.flatMap((s, i) => s.timingHidden ? [i] : [])
  const moved = segments.flatMap((s, i) => s.timingOriginalStart !== undefined ? [i] : [])
  const selected = review.selected !== null && flagged.includes(review.selected) ? review.selected : flagged[0]
  const finding = assessment?.findings.find(f => f.index === selected)
  const jump = (index: number) => { review.setSelected(index); onJump(index) }
  const step = (direction: number) => {
    if (!flagged.length) return
    const position = flagged.indexOf(selected)
    jump(flagged[(position + direction + flagged.length) % flagged.length])
  }
  const apply = async (index: number, action: TimingReviewAction) => {
    if (!assessment || busy) return
    review.setBusy(true)
    review.setFailure(null)
    try {
      const result = await window.electronAPI.transcripts.reviewTiming({ recordingId, fingerprint: assessment.fingerprint, index, action })
      if (!result.success) review.setFailure(result.error.message)
      else { onUpdated(result.data); review.reload() }
    } catch (err) { review.setFailure(err instanceof Error ? err.message : 'Could not save timing review') }
    finally { review.setBusy(false) }
  }
  const regenerate = async () => {
    review.setBusy(true)
    review.setFailure(null)
    try {
      const result = await window.electronAPI.transcripts.regenerateSummary({ recordingId })
      if (!result.success) review.setFailure(result.error.message)
      else onSummaryUpdated(result.data)
    } catch (err) { review.setFailure(err instanceof Error ? err.message : 'Could not regenerate summary') }
    finally { review.setBusy(false) }
  }
  if (!flagged.length && !hidden.length && !moved.length && !assessment?.reviewed) return null
  return (
    <div className="mb-3 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs" data-testid="transcript-timing-review">
      {flagged.length > 0 && <>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Review flagged lines</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => step(-1)}>Previous flagged line</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => step(1)}>Next flagged line</Button>
          <span>{flagged.indexOf(selected) + 1} / {flagged.length}</span>
        </div>
        <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto" aria-label="Flagged transcript lines">
          {flagged.map(index => <button key={index} type="button" onClick={() => jump(index)}
            aria-pressed={selected === index} aria-label={`Jump to flagged line ${index + 1} at ${clock(segments[index].start)}`}
            className="rounded border px-2 py-1 hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
            {clock(segments[index].start)} · line {index + 1}
          </button>)}
        </div>
        {finding && <div className="space-y-1" data-testid="timing-outlier-classification">
          <p className="font-medium">{clock(finding.claimedStart)} · {TIMING_CLASSIFICATION_LABELS[finding.classification]}</p>
          <p>{finding.detail}</p>
          <div className="flex flex-wrap gap-2">
            {finding.classification === 'out_of_place' && finding.suggestedStart !== null &&
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void apply(finding.index, 'move')}>Move to {preciseClock(finding.suggestedStart)}</Button>}
            <Button size="sm" variant="outline" disabled={busy || !assessment} onClick={() => void apply(finding.index, 'hide')}>Hide this line</Button>
          </div>
        </div>}
        {!assessment && <p role="status">{failure ?? 'Checking audio evidence…'}</p>}
      </>}
      {hidden.length > 0 && <details><summary className="cursor-pointer">Hidden lines ({hidden.length})</summary>
        {hidden.map(index => <div key={index} className="mt-2 space-y-1">
          <p>{clock(segments[index]?.start ?? 0)} · {segments[index]?.text}</p>
          <Button size="sm" variant="outline" disabled={busy || !assessment} onClick={() => void apply(index, 'show')}>Show line {index + 1} again</Button>
        </div>)}
      </details>}
      {moved.map(index => <Button key={index} size="sm" variant="ghost" disabled={busy || !assessment} onClick={() => void apply(index, 'undo_move')}>Undo move of line {index + 1}</Button>)}
      {(assessment?.reviewed || segments.some(s => s.timingReviewed)) && <div className="flex flex-wrap items-center gap-2">
        <span>The summary and actions have not been regenerated from these edits.</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void regenerate()}>Regenerate summary</Button>
      </div>}
      {failure && assessment && <p role="alert" className="text-destructive">{failure}</p>}
    </div>
  )
}
