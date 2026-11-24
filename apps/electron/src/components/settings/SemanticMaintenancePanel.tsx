import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { SemanticIndexStatus } from '../../../electron/preload/index'

const STATE_LABELS: Record<SemanticIndexStatus['state'], string> = {
  idle: 'Not started', running: 'Running', pausing: 'Finishing current batch before pause',
  paused: 'Paused', cancelling: 'Cancelling — waiting for the current request to settle',
  cancelled: 'Cancelled', completed: 'Bounded operation completed', failed: 'Failed',
  interrupted: 'Interrupted — explicit resume required',
}

export function SemanticMaintenancePanel({ selected }: { selected: boolean }): React.ReactElement {
  const config = useConfigStore(s => s.config)
  const [status, setStatus] = useState<SemanticIndexStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const paired = !!config?.transcription?.modelHostUrl && !!config?.transcription?.modelHostToken
  useEffect(() => {
    let disposed = false, pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const next = await window.electronAPI.semanticIndex.status()
        if (!disposed) { setStatus(next); setUnavailable(false) }
      } catch { if (!disposed) setUnavailable(true) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => { disposed = true; clearInterval(timer) }
  }, [])

  const act = async (action: 'start' | 'pause' | 'resume' | 'cancel') => {
    setBusy(true); setError('')
    try {
      const api = window.electronAPI.semanticIndex
      const next = action === 'start' ? await api.start({ maxRecordings: 1, maxBatches: 4 })
        : await api[action]({ runId: status!.runId! })
      setStatus(next); setUnavailable(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The requested operation was not accepted.') }
    finally { setBusy(false) }
  }
  const active = status && ['running', 'pausing', 'cancelling'].includes(status.state)
  const canResume = status?.runId && ['paused', 'interrupted', 'failed'].includes(status.state)
  const boundedRun = !!status && status.maxRecordings <= 1 && status.maxBatches <= 4
  const configured = selected && paired
  // Start/Resume authenticate and verify readiness before uploading text. Unknown is not Ready.
  const disabled = busy || unavailable || !status
  const readyLabel = status?.hostReady === true ? 'Ready at last check'
    : status?.hostReady === false ? 'Unavailable at last check; retry verifies readiness before upload'
      : 'Not checked — Start verifies readiness before sending text'
  return <section aria-label="Remote semantic indexing" className="space-y-3 border-t border-border pt-4">
    <div>
      <h3 className="text-sm font-medium">Remote semantic indexing</h3>
      <p className="text-xs text-muted-foreground">Explicit maintenance only: one recording, up to four batches per Start or Resume.
        Nothing starts or resumes automatically when HiDock opens. Existing provider partitions are preserved.</p>
    </div>
    <p role="status" aria-live="polite" className="text-sm">
      {unavailable ? 'Index status unavailable' : status ? STATE_LABELS[status.state] : 'Reading index status…'}
    </p>
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
      <dt className="text-muted-foreground">Node</dt><dd className="break-all">{status?.hostUrl || config?.transcription?.modelHostUrl || 'Not paired'}</dd>
      <dt className="text-muted-foreground">Provider / model</dt><dd>{status?.provider || 'model-host-embed'} / local/nemotron-3-embed-1b</dd>
      <dt className="text-muted-foreground">Pinned space</dt><dd className="break-all">{status?.spaceId || 'Verified before Start'}</dd>
      <dt className="text-muted-foreground">Host</dt><dd>{readyLabel}</dd>
      <dt className="text-muted-foreground">Current partition</dt><dd>{status ? `${status.activePartitionRows.toLocaleString()} indexed chunks` : 'Unknown'}</dd>
      <dt className="text-muted-foreground">Preserved other partitions</dt><dd>{status ? `${status.otherPartitionRows.toLocaleString()} chunks` : 'Unknown'}</dd>
      <dt className="text-muted-foreground">Run progress</dt><dd>{status ? `${status.completedRecordings} recordings · ${status.batches} batches · ${status.indexedChunks} chunks saved (cumulative)` : 'Unknown'}</dd>
    </dl>
    {status?.activePartitionRows === 0 && <p className="text-xs text-muted-foreground">This remote index is empty. Previous vectors cannot be reused in a different model space.</p>}
    {!configured && <p className="text-xs text-muted-foreground">Pair the host and select its semantic embedding role first.</p>}
    {canResume && !boundedRun && <p role="alert" className="text-sm text-destructive">This saved run exceeds the one-recording/four-batch limit. Cancel it before starting a bounded operation here.</p>}
    <p className="text-xs text-muted-foreground">Pause finishes the current batch. Cancel prevents late results from being saved and waits for the request to settle (up to 120 seconds). Saved chunks remain. No local or paid fallback.</p>
    {(error || status?.error) && <p role="alert" className="text-sm text-destructive">{error || status?.error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={disabled || !configured || !!active || !!canResume} onClick={() => void act('start')}>Start one recording</Button>
      <Button size="sm" variant="outline" disabled={disabled || status?.state !== 'running'} onClick={() => void act('pause')}>Pause</Button>
      <Button size="sm" variant="outline" disabled={disabled || !configured || !canResume || !boundedRun} onClick={() => void act('resume')}>Resume</Button>
      <Button size="sm" variant="outline" disabled={disabled || !status?.runId || !['running', 'pausing', 'paused', 'interrupted', 'failed'].includes(status.state)} onClick={() => void act('cancel')}>Cancel</Button>
    </div>
  </section>
}

