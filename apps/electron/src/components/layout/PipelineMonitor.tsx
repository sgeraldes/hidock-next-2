import { useEffect, useRef, useState } from 'react'
import { Server, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { PipelineNodeIndicators } from './PipelineNodeIndicators'
import type { PipelineTelemetry } from '@/shared/pipeline-telemetry'

const number = (value: number | null | undefined, unit: string) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : 'Unavailable'

const mibToDecimalGb = (value: number | null | undefined) =>

  value == null ? value : value * 1_048_576 / 1_000_000_000

export function PipelineMonitor() {
  const opener = useRef<HTMLElement | null>(null)  const closeReason = useRef<'escape' | 'outside' | null>(null)
  const [actionMessage, setActionMessage] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const perform = async (key: string, action: () => Promise<unknown>, message: string) => {
    if (busyAction) return
    setBusyAction(key)
    try {
      const result = await action() as { success?: boolean; error?: string }
      if (result?.success === false) throw new Error(result.error || 'Operation failed')
      setActionMessage(message)
      setSnapshot(await window.electronAPI.modelHost.telemetry())
    } catch (error) { setActionMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusyAction(null) }
  }
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<PipelineTelemetry | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [includeHistory, setIncludeHistory] = useState(false)
  const [windowDelayMs, setWindowDelayMs] = useState(0)
  useEffect(() => {
    let previous = performance.now()
    let visible = document.visibilityState === 'visible'
    let peak = 0
    const timer = setInterval(() => {
      const now = performance.now()
      const currentVisible = document.visibilityState === 'visible'
      // Background timer throttling is not evidence of a foreground freeze.
      if (visible && currentVisible) {
        const delay = Math.max(0, now - previous - 1000)
        if (delay > peak + 10) { peak = delay; setWindowDelayMs(delay) }
      }
      previous = now
      visible = currentVisible
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        if (typeof window.electronAPI.modelHost.telemetry !== 'function') throw new Error('MONITOR_UPDATE_REQUIRED')
        const result = await window.electronAPI.modelHost.telemetry()
        if (alive) {
          setSnapshot(previous => previous && ((result.revision ?? 0) < (previous.revision ?? 0)
            || Date.parse(result.sampledAt) < Date.parse(previous.sampledAt)) ? previous : result)
          setUnavailable(false); setRestartRequired(false)
        }
      } catch (error) {
        if (alive) {
          const message = error instanceof Error ? error.message : ''
          setUnavailable(true)
          setRestartRequired(message === 'MONITOR_UPDATE_REQUIRED'
            || message.includes("No handler registered for 'model-host:telemetry'"))
        }
      }
      if (alive) timer = setTimeout(() => void tick(), open ? 5000 : 15000)
    }
    void tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [open])
  const host = snapshot?.host.telemetry
  return (
    <Popover open={open} onOpenChange={next => { if (next) closeReason.current = null; setOpen(next) }}>
      <PopoverAnchor asChild>
        <div><PipelineNodeIndicators snapshot={snapshot} unavailable={unavailable} open={open} onOptionsOpen={() => setOpen(false)} onOpen={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          setOpen(true)
        }} /></div>
      </PopoverAnchor>
      <PopoverContent align="end"        onEscapeKeyDown={() => { closeReason.current = 'escape' }}        onInteractOutside={() => { closeReason.current = 'outside' }}        onCloseAutoFocus={event => {          event.preventDefault()          if (closeReason.current !== 'outside') opener.current?.focus()          closeReason.current = null        }}
        sideOffset={2} className="max-h-[80vh] w-[min(880px,calc(100vw-32px))] overflow-auto p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Processing monitor</h2>
          <button type="button" aria-label="Close processing monitor" onClick={() => setOpen(false)}
            className="titlebar-no-drag rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-sky-400">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          {unavailable ? restartRequired
            ? 'Restart HiDock to load the matching monitor backend. This message does not indicate transcription failure.'
            : 'The metrics request failed. Transcription may still be running; last measurements may be stale.' : snapshot
            ? `Measured ${new Date(snapshot.sampledAt).toLocaleTimeString()} · ${snapshot.queue.processingCount} active · ${snapshot.queue.pendingCount} queued${snapshot.queue.paused ? ' · paused' : ''}`
            : 'Loading measurements…'}
        </p>
        {snapshot && <>
          <div className="mt-5 grid gap-6 sm:grid-cols-2">
            <section>
              <h3 className="font-medium">This computer</h3>
              <dl className="mt-2 space-y-1 text-sm tabular-nums">
                <Metric label="Whole-computer CPU" value={number(snapshot.client.systemCpuPercent, '%')} />
                <Metric label={`Electron CPU${snapshot.client.cpuPartial ? ' · partial' : ''}`}
                  value={number(snapshot.client.cpuPercent, '%')} />
                <Metric label="Electron working sets" value={number(mibToDecimalGb(snapshot.client.ramMiB), ' GB')} />
                <Metric label="System RAM available" value={number(mibToDecimalGb(snapshot.client.freeRamMiB), ' GB')} />
                <Metric label="Main-loop delay" value={number(snapshot.client.eventLoopDelayMs, ' ms')} />
                <Metric label="Peak since monitor started" value={number(snapshot.client.peakEventLoopDelayMs, ' ms')} />
                <Metric label="Window scheduling peak" value={number(windowDelayMs, ' ms')} />
                <Metric label="Local embeddings" value={snapshot.client.localIndexingState || 'Unavailable'} />
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">CPU spans all cores. Electron excludes Python and ffmpeg; working sets can count shared pages twice. Window scheduling measures JavaScript delay; graphics or input can still stall separately.</p>
              {snapshot.client.localComputePauseReason && <p className="mt-2 text-xs text-amber-500" role="status">
                {snapshot.client.localComputePauseReason}</p>}
              {snapshot.client.localIndexingPauseReason && <p className="mt-2 text-xs text-amber-500" role="status">
                {snapshot.client.localIndexingPauseReason}</p>}
            </section>
            <section>
              <h3 className="flex items-center gap-2 font-medium"><Server className="h-4 w-4" />
                {host?.hostname || snapshot.host.address || 'No model host'}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{snapshot.host.reachable
                ? host ? `Measured ${new Date(host.sampledAt).toLocaleTimeString()} · whole host`
                  : 'Connected · install the host update for live measurements'
                : snapshot.host.usedForSpeakers ? 'Offline or unavailable · no local voice worker will start'
                  : 'Offline or unavailable · the selected voice engine runs here'}</p>
              <dl className="mt-2 space-y-1 text-sm tabular-nums">
                <Metric label="Host CPU" value={number(host?.cpuPercent, '%')} />
                <Metric label="Host RAM used" value={number(mibToDecimalGb(host?.memoryUsedMiB), ' GB')} />
                <Metric label={host?.gpu?.name || 'GPU'} value={number(host?.gpu?.utilizationPercent, '%')} />
                <Metric label="GPU memory" value={number(mibToDecimalGb(host?.gpu?.usedMiB), ' GB')} />
                <Metric label="Completed jobs / wall time" value={host
                  ? `${host.completedJobs} / ${number(host.totalJobMs / 1000, ' s')}` : 'Unavailable'} />
                <Metric label="Average output tokens / second" value={number(host?.tokenRateBasis === 'completed-measured-job-wall-average' ? host.outputTokensPerSecondAverage : null, ' tk/s')} />
                <Metric label="Token measurement coverage" value={host?.tokenRateBasis === 'completed-measured-job-wall-average'
                  ? `${host.tokenMeasuredJobs ?? 'unknown'} measured jobs / ${host.completedJobsWithoutTokenUsage ?? 'unknown'} completed without token usage; measured job wall time ${number(host.tokenMeasuredJobMs == null ? null : host.tokenMeasuredJobMs / 1000, ' s')}` : 'Unavailable'} />
                <Metric label="Active host jobs" value={host ? String(host.activeJobs.length) : 'Unavailable'} />
              </dl>
              {host?.activeJobs.slice(0, 5).map(job => <p key={job.id} className="mt-2 text-xs text-muted-foreground">
                {job.stage} · {job.model} · {job.status || 'admitted'} · {number(job.elapsedMs / 1000, ' s')}
              </p>)}
            </section>
          </div>
          <div className="mt-6 flex items-center justify-between gap-2">
            <h3 className="font-medium">Operations · execution timeline</h3>
            <button type="button" disabled={!!busyAction} className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
              onClick={() => void perform('queue', () => snapshot.queue.paused
                ? window.electronAPI.recordings.resumeTranscriptionQueue()
                : window.electronAPI.recordings.pauseTranscriptionQueue(),
                snapshot.queue.paused ? 'Queue resumed.' : 'Queue paused. The current recording can finish.')}
            >{snapshot.queue.paused ? 'Resume queue' : 'Pause queue'}</button>
          </div>
          {actionMessage && <p role="status" className="mt-2 text-xs">{actionMessage}</p>}
          <p className="mt-1 text-xs text-muted-foreground">Latest audio pass, starting at voice activity detection. Wall time includes waiting.</p>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={includeHistory} onChange={event => setIncludeHistory(event.target.checked)} />
            Include earlier audio passes (up to 80 spans per recording)
          </label>
          {snapshot.jobs.map(job => {
            const lastVad = job.spans.filter(span => span.stage === 'vad').at(-1)
            const spans = includeHistory || !lastVad ? job.spans
              : job.spans.filter(span => Date.parse(span.startedAt) >= Date.parse(lastVad.startedAt))
            const start = Math.min(...spans.map(span => Date.parse(span.startedAt)))
            const end = Math.max(...spans.map(span => Date.parse(span.startedAt) + span.durationMs))
            const duration = Math.max(1, end - start)
            const totalTokens = spans.reduce((sum, span) => sum + (span.tokens ?? 0), 0)
            const measured = spans.some(span => span.tokens !== null)
            return <section key={job.recordingId} className="mt-4 border-t pt-3">
              <h4 className="break-all text-sm font-medium">{job.filename}{job.active ? ' · active' : ''}</h4>
              <p className="mt-1 text-xs text-muted-foreground">Tokens reported for these spans: {measured ? totalTokens.toLocaleString() : 'Unavailable'}
                {spans.length > 0 ? ` · ${number(duration / 1000, ' s')} ${includeHistory ? 'history window' : 'elapsed span'}` : ' · not processed'}</p>
              {job.latestCheckpoint && <p className="mt-1 text-xs text-muted-foreground">Saved checkpoint: {job.latestCheckpoint}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                {job.canCancel ? <button type="button" disabled={!!busyAction} className="rounded border px-2 py-1 hover:bg-muted disabled:opacity-50"
                  onClick={() => void perform(job.recordingId, () => window.electronAPI.recordings.cancelTranscription(job.recordingId),
                    'Cancellation requested. Active work remains visible until its owner exits.')}>Cancel</button>
                  : job.canResume &&
                    <button type="button" disabled={!!busyAction || job.uncertainProviderRequest} className="rounded border px-2 py-1 hover:bg-muted disabled:opacity-50"
                      onClick={() => void perform(job.recordingId, () => window.electronAPI.recordings.resumeTranscription(job.recordingId),
                        'Resume queued. Completed checkpoints are retained.')}>Resume from checkpoints</button>}
                  {job.canRestartLocalStage && <button type="button" disabled={!!busyAction}                    className="rounded border px-2 py-1 hover:bg-muted disabled:opacity-50"                    title="Stop the local stage, wait for its worker to exit, then resume saved stages with the current CPU setting."                    onClick={() => void perform(job.recordingId,                      () => window.electronAPI.recordings.restartLocalStage(job.recordingId),                      'Previous worker exited. Resume queued with the current CPU limit.')}>                    Restart local stage with current CPU limit                  </button>}                  {job.uncertainProviderRequest ? <span className="text-amber-500">A provider request has an unknown outcome. Automatic resend is blocked.</span>
                  : job.canResume && <span className="text-muted-foreground">Uses saved stages; unfinished cloud stages may incur usage.</span>}
              </div>
              <div className="mt-2 space-y-2">
                {spans.map(span => <div key={span.id} className="grid grid-cols-[minmax(0,1fr)_5rem] gap-x-3 text-xs">
                  <span className="truncate" title={`${span.stage} · ${span.model || span.tool || ''} · ${span.device || 'device not reported'}${span.hostJobId ? ` · host job ${span.hostJobId}` : ''}`}>
                    {span.stage} · {span.location} · {span.status}
                  </span>
                  <span className="text-right tabular-nums">{number(span.durationMs / 1000, ' s')}</span>
                  <span className="col-span-2 text-muted-foreground">{span.model || span.tool || 'Model not recorded'} · {span.device || 'Device not reported'}</span>
                    {span.resourcePolicy && <span className="col-span-2 text-muted-foreground">                      Applied: {span.resourcePolicy.cpuPercent ?? '—'}% CPU · {span.resourcePolicy.threads ?? '—'} threads                      {' · '}{span.resourcePolicy.priority ?? 'Priority not reported'}                    </span>}                    {span.error && <span className="col-span-2 break-words text-amber-500">{span.error}</span>}
                  <div className="col-span-2 h-1.5 overflow-hidden rounded-sm bg-muted" aria-hidden="true">
                    <div className={`h-full rounded-sm ${span.status === 'failed' ? 'bg-amber-500' : 'bg-primary'}`}
                      style={{ marginLeft: `${Math.max(0, (Date.parse(span.startedAt) - start) / duration * 100)}%`,
                        width: `${Math.max(0.4, span.durationMs / duration * 100)}%` }} />
                  </div>
                </div>)}
              </div>
            </section>
          })}
        </>}
      </PopoverContent>
    </Popover>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt>
    <dd className="text-right">{value}</dd></div>
}
