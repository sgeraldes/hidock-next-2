import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  HOST_ALIGN_MIN_SECONDS, OVERLAP_SECONDS, TIMING_CLASSIFICATION_LABELS, TIMING_FIX_METHOD_LABELS, TIMING_KIND_LABELS,
  hostAlignmentSeconds, type TimingAssessment, type TimingFinding, type TimingSegment
} from '@/shared/transcript-timing'
import type { TranscriptContentUpdate } from './TranscriptViewer'
import { formatTimestamp } from '../utils/formatTimestamp'

const preciseClock = (seconds: number) => {
  const tenths = Math.round((seconds % 1) * 10) % 10
  return tenths ? `${formatTimestamp(seconds)}.${tenths}` : formatTimestamp(seconds)
}

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
    }).catch(err => { if (!cancelled) setFailure(err instanceof Error ? err.message : 'Could not check the audio') })
    return () => { cancelled = true }
  }, [recordingId, revision, refresh])
  useEffect(() => { setSelected(null) }, [recordingId])
  return { assessment, failure, busy, selected, setSelected, setBusy, setFailure, reload: () => setRefresh(n => n + 1) }
}

type ReviewState = ReturnType<typeof useTranscriptTimingReview>
interface Props {
  recordingId: string
  segments?: TimingSegment[]
  /** Kept for the reader's past-the-end mark; the findings come from the main process. */
  pastAudioEnd?: boolean
  review: ReviewState
  onJump: (index: number) => void
  onUpdated: (update: TranscriptContentUpdate) => void
}

function chipLabel(finding: TimingFinding): string {
  const lines = finding.lines.length
  return `${TIMING_KIND_LABELS[finding.kind]} · ${formatTimestamp(finding.claimedStart)}${lines > 1 ? ` · ${lines} lines` : ''}`
}

function lineRange(from: number, to: number): string {
  return from === to ? `line ${from + 1}` : `lines ${from + 1} to ${to + 1}`
}

export function TranscriptTimingReview({ recordingId, segments = [], review, onJump, onUpdated }: Props) {
  const { assessment, busy, failure } = review
  const [confirming, setConfirming] = useState<string | null>(null)
  // Which fix refused for which finding: the computer-only one, or the model host's (which
  // falls back to the computer-only one, so its refusal means both). CodeRabbit review of #198.
  const [localRefused, setLocalRefused] = useState<string | null>(null)
  const [hostRefused, setHostRefused] = useState<string | null>(null)
  // Chosen by id: a shifted section and a duplicate can start on the same line.
  const [chosenId, setChosenId] = useState<string | null>(null)
  useEffect(() => { setConfirming(null); setLocalRefused(null); setHostRefused(null) }, [assessment?.fingerprint])
  const currentRecording = useRef(recordingId)
  useEffect(() => { currentRecording.current = recordingId }, [recordingId])
  const findings = assessment?.findings ?? []
  const hidden = assessment?.hiddenIndices ?? []
  const fixed = assessment?.fixedRanges ?? []
  const sections = assessment?.sectionRuns ?? []
  const chosen = findings.find(f => f.id === chosenId)
  // A jump from elsewhere (the integrity panel's tags) selects the finding on that line.
  const current = (chosen && (review.selected === null || chosen.from === review.selected || chosen.lines.includes(review.selected) || !!chosen.originals?.includes(review.selected)) ? chosen : undefined)
    ?? findings.find(f => f.from === review.selected) ?? findings.find(f => f.lines.includes(review.selected ?? -1)) ?? findings[0]
  const jump = (index: number) => { review.setSelected(index); onJump(index) }
  const choose = (finding: TimingFinding) => { setChosenId(finding.id); jump(finding.from) }
  const step = (direction: number) => {
    if (!findings.length) return
    const position = current ? findings.indexOf(current) : -1
    choose(findings[(position + direction + findings.length) % findings.length])
  }

  const save = async (call: () => Promise<{ success: true; data: TranscriptContentUpdate } | { success: false; error: { message: string; details?: unknown } }>, onLowConfidence?: { id: string; host: boolean }) => {
    if (busy) return
    const startedFor = recordingId
    review.setBusy(true)
    review.setFailure(null)
    try {
      const result = await call()
      // The owner moved to another recording while this saved: its lines must
      // not replace the transcript now on screen (CodeRabbit review of #195).
      if (currentRecording.current !== startedFor) return
      if (result.success) {
        onUpdated(result.data)
        review.reload()
        return
      }
      const details = result.error.details as { lowConfidence?: boolean } | undefined
      if (onLowConfidence && details?.lowConfidence) {
        setLocalRefused(onLowConfidence.id)
        if (onLowConfidence.host) setHostRefused(onLowConfidence.id)
      }
      review.setFailure(result.error.message)
    } catch (err) {
      review.setFailure(err instanceof Error ? err.message : 'Could not save the timing review')
    } finally {
      review.setBusy(false)
    }
  }
  const act = (request: Omit<Parameters<typeof window.electronAPI.transcripts.reviewTiming>[0], 'recordingId' | 'fingerprint'>, onLowConfidence?: { id: string; host: boolean }) => {
    if (!assessment) return
    void save(() => window.electronAPI.transcripts.reviewTiming({ recordingId, fingerprint: assessment.fingerprint, ...request }), onLowConfidence)
  }
  const retranscribe = (finding: TimingFinding) => {
    if (!assessment) return
    setConfirming(null)
    void save(() => window.electronAPI.transcripts.retranscribeSection({ recordingId, fingerprint: assessment.fingerprint, findingId: finding.id }))
  }

  if (!assessment) {
    return <p role="status" className="mb-3 text-xs text-muted-foreground" data-testid="transcript-timing-review">{failure ?? 'Checking the audio for these lines…'}</p>
  }
  if (!findings.length && !hidden.length && !fixed.length && !sections.length) return null

  // The model host hears the words, so it can place lines the sound alone cannot.
  const hostFix = !!assessment.wordAlignment && current?.kind !== 'duplicate' && current?.fix?.hostEligible === true
  const offerSection = current && current.kind !== 'duplicate' && current.windowStart !== null && current.windowEnd !== null &&
    (current.fix?.offerSection === true || ((localRefused === current.id || hostRefused === current.id) && (current.fix?.displacement ?? Infinity) >= OVERLAP_SECONDS))
  return (
    <div className="mb-3 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs" data-testid="transcript-timing-review">
      {findings.length > 0 && <>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{findings.length === 1 ? 'One timing problem' : `${findings.length} timing problems`}</span>
          {findings.length > 1 && <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => step(-1)}>Previous</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => step(1)}>Next</Button>
          </>}
        </div>
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" aria-label="Go to a timing problem">
          {findings.map(finding => (
            <button key={finding.id} type="button" onClick={() => choose(finding)} data-finding={finding.id}
              aria-pressed={current?.id === finding.id}
              className="rounded border px-2 py-1 hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent">
              {chipLabel(finding)}
            </button>
          ))}
        </div>
        {current && <div className="space-y-1" data-testid="timing-outlier-classification" data-kind={current.kind}>
          <p className="font-medium">
            {TIMING_KIND_LABELS[current.kind]} at {formatTimestamp(current.claimedStart)}, {lineRange(current.from, current.to)}
            {current.kind !== 'duplicate' && <> · {TIMING_CLASSIFICATION_LABELS[current.classification]}</>}
          </p>
          <p>{current.detail}</p>
          <div className="flex flex-wrap gap-2">
            {current.kind === 'duplicate' ? <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'hide', findingId: current.id })}>
                Hide the copy
              </Button>
              {current.originals && <Button size="sm" variant="ghost" disabled={busy} onClick={() => jump(current.originals![0])}>Go to the first copy</Button>}
            </> : <>
              {hostFix && hostRefused !== current.id && (
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => act({ action: 'fix_times', findingId: current.id, useHost: true }, { id: current.id, host: true })}>
                  Fix times with Parakeet on the model host
                </Button>
              )}
              {current.fix?.ok && current.fix.firstStart !== null && localRefused !== current.id && (
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => act({ action: 'fix_times', findingId: current.id }, { id: current.id, host: false })}>
                  Fix times (from {preciseClock(current.fix.firstStart)})
                </Button>
              )}
              {current.classification === 'probable_hallucination' && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'hide', findingId: current.id })}>
                  Hide {current.lines.length === 1 ? 'this line' : 'these lines'}
                </Button>
              )}
              {offerSection && confirming !== current.id && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(current.id)}>
                  Transcribe this section again
                </Button>
              )}
            </>}
          </div>
          {hostFix && hostRefused !== current.id && current.windowStart !== null && current.windowEnd !== null && (
            <p className="text-muted-foreground">
              Fix times with Parakeet sends only about {Math.round(hostAlignmentSeconds(current.windowStart, current.windowEnd))} s of audio around {current.lines.length === 1 ? 'this line' : 'these lines'} to the model host, where Parakeet hears the words; the transcript stays here.
              Shorter stretches go out as {HOST_ALIGN_MIN_SECONDS} s, so Parakeet can tell the language.
              If the host does not answer, the times come from the speech on this computer.
            </p>
          )}
          {current && current.kind !== 'duplicate' && !current.fix?.ok && current.fix?.reason && <p className="text-muted-foreground">{current.fix.reason}</p>}
          {offerSection && confirming === current.id && current.windowStart !== null && current.windowEnd !== null && (
            <div role="alertdialog" aria-label="Transcribe this section again" className="space-y-1 rounded border border-border bg-background px-2 py-1.5" data-testid="section-retranscribe-confirm">
              <p>
                This sends {Math.round(current.windowEnd - current.windowStart)} s of audio, from {formatTimestamp(current.windowStart)} to {formatTimestamp(current.windowEnd)}, to Gemini to transcribe again.
                The provider may charge for it. The current lines stay in the transcript, hidden, and Undo brings them back.
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => retranscribe(current)}>Transcribe</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>}
      </>}
      {fixed.map(range => (
        <div key={`fixed-${range.from}`} className="flex flex-wrap items-center gap-2">
          <span>Times fixed on {lineRange(range.from, range.to)}{range.method ? `, ${TIMING_FIX_METHOD_LABELS[range.method]}` : ''}.</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => jump(range.from)}>Go there</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: 'undo_fix', range })}>Undo</Button>
        </div>
      ))}
      {sections.map(run => (
        <div key={run.runId} className="flex flex-wrap items-center gap-2">
          <span>Section transcribed again: {lineRange(run.from, run.to)}.</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => jump(run.from)}>Go there</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: 'undo_section', runId: run.runId })}>Undo</Button>
        </div>
      ))}
      {hidden.length > 0 && <details><summary className="cursor-pointer">Hidden lines ({hidden.length})</summary>
        {hidden.map(index => <div key={index} className="mt-2 space-y-1">
          <p>{formatTimestamp(segments[index]?.start ?? 0)} · {segments[index]?.text}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'show', indices: [index] })}>Show line {index + 1} again</Button>
        </div>)}
      </details>}
      {failure && <p role="alert" className="text-destructive">{failure}</p>}
    </div>
  )
}
