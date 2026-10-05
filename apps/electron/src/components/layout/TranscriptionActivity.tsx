import { useEffect, useState } from 'react'
import type { TranscriptionItem } from '@/store/features/useTranscriptionStore'

const steps = [
  ['reading_file', 'Checking audio'], ['vad', 'Detecting speech'],
  ['voices', 'Separating speakers'], ['transcribing', 'Transcribing audio'],
  ['analyzing', 'Writing summary'], ['detecting_actionables', 'Finding action items'],
  ['indexing', 'Updating search']
] as const

export function activityStage(stage?: string): { label: string; step: number; fraction?: number } {
  const part = stage?.match(/(?:transcribing_part|vibevoice_chunk)_(\d+)_of_(\d+)/)
  if (part) return { label: `Transcribing part ${part[1]} of ${part[2]}`, step: 4, fraction: Math.round(((Number(part[1]) - 1) / Number(part[2])) * 100) }
  const ledger: Record<string, {label:string;step:number}> = {
    metadata: {label:'Checking recording details',step:1}, 'schedule-match': {label:'Checking calendar',step:1},
    'voice-id': {label:'Identifying speakers',step:3}, title: {label:'Writing recording title',step:5},
    'meeting-resolution': {label:'Matching meeting',step:5}, persistence: {label:'Saving transcript',step:5},
    'actionable-detection': {label:'Finding action items',step:6}, 'timeline-analysis': {label:'Building timeline',step:6},
    'org-reconciliation': {label:'Updating people',step:6}, 'speaker-identity': {label:'Matching speaker identities',step:6},
    'graph-sync': {label:'Updating knowledge graph',step:7}, 'wiki-export': {label:'Writing source page',step:7}
  }
  if (stage && ledger[stage]) return ledger[stage]
  const normalized = stage === 'diarization' ? 'voices' : stage === 'summary' ? 'analyzing' : stage === 'transcription' ? 'transcribing' : stage === 'rag-indexing' ? 'indexing' : stage
  const index = steps.findIndex(([key]) => key === normalized)
  return index < 0 ? { label: stage?.startsWith('local_asr') || stage?.startsWith('vibevoice') ? 'Transcribing audio' : stage ? 'Processing recording' : 'Checking audio', step: stage?.startsWith('local_asr') || stage?.startsWith('vibevoice') ? 4 : 1 } : { label: steps[index][1], step: index + 1 }
}

/** Preserve unknown diagnostics; explain common failures and the next useful action. */
export function transcriptionFailure(error?: string): string {
  if (!error) return 'Transcription failed. Try again.'
  if (/could not determine recording duration/i.test(error)) return "The recording's audio length could not be read. Retry to check the audio again."
  if (/no local file|file not found/i.test(error)) return 'The audio file is missing. Download or restore it, then retry.'
  if (/api key|HF_TOKEN|hugging face token|ASR path/i.test(error)) return `${error}. Update the transcription settings, then retry.`
  if (/rate limit|429/i.test(error)) return 'The transcription service is busy. Wait a moment, then retry.'
  return error
}

/** Projection of existing queue progress events; shared by Operations and Notifications. */
export function TranscriptionActivity({ item, onStop, onRetry, onDismiss }: {
  item: TranscriptionItem
  onStop?: (recordingId: string) => void
  onRetry?: (queueId: string) => void
  onDismiss?: (queueId: string) => void
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (item.status !== 'processing') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [item.status])
  const stage = activityStage(item.stage)
  const elapsed = Math.max(0, Math.floor((now - (item.startedAt?.getTime() ?? now)) / 1000))
  const stamp = (item.status === 'failed' || item.status === 'cancelled') ? item.completedAt : item.status === 'processing' ? item.startedAt : item.createdAt
  const timeLabel = item.status === 'cancelled' ? 'Stopped' : item.status === 'failed' ? 'Failed' : item.status === 'processing' ? 'Started' : 'Queued'
  return <div className="space-y-1 text-xs">
    {item.status === 'processing' && <>
      <div>{stage.label} · step {stage.step} of {steps.length} · {Math.floor(elapsed / 60)}m {elapsed % 60}s elapsed</div>
      <progress aria-label={stage.label} max={100} value={stage.fraction ?? (stage.step - 1) / steps.length * 100}
        aria-valuenow={stage.fraction ?? Math.round((stage.step - 1) / steps.length * 100)} className="h-1.5 w-full accent-sky-500" />
    </>}
    {item.status === 'pending' && <div>Waiting to transcribe</div>}
    {item.status === 'cancelled' && <div className="select-text whitespace-normal text-muted-foreground">{item.error || 'Stopped by you'}</div>}
    {item.status === 'failed' && <div className="select-text whitespace-normal text-red-400">{transcriptionFailure(item.error)}</div>}
    {stamp && <div className="text-muted-foreground">{timeLabel} {stamp.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}</div>}
    {item.status === 'processing' && onStop && <button type="button" onClick={() => onStop(item.recordingId)} className="rounded px-2 py-1 text-red-400 hover:bg-red-500/10 focus-visible:ring-2">Stop</button>}
    {item.status === 'cancelled' && onRetry && <button type="button" onClick={() => onRetry(item.id)} className="rounded px-2 py-1 hover:bg-accent focus-visible:ring-2">{item.error?.includes('after the transcript was saved') ? 'Finish processing' : 'Retry'}</button>}
    {item.status === 'cancelled' && onDismiss && <button type="button" onClick={() => onDismiss(item.id)} className="rounded px-2 py-1 hover:bg-accent focus-visible:ring-2">Dismiss</button>}
    {item.status === 'failed' && onRetry && <button type="button" onClick={() => onRetry(item.id)} className="rounded px-2 py-1 hover:bg-accent focus-visible:ring-2">Retry</button>}
  </div>
}
