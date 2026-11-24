import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * A transcript without its summary: the owner writes it now (28-oct-2026,
 * Sebastián asked for a manual retry of the steps that did not run). The same
 * AI brains are tried in the same order as the automatic path.
 */
export function GenerateSummaryPanel({ recordingId, onWritten }: { recordingId: string; onWritten: () => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'failed'>('idle')
  const [message, setMessage] = useState('')

  const run = async () => {
    setState('running')
    setMessage('')
    try {
      const result = await window.electronAPI.transcripts.retrySummary({ recordingId })
      if (result.success && result.data.written) {
        setState('idle')
        onWritten()
        return
      }
      setState('failed')
      setMessage(result.success
        ? 'No AI brain could write the summary. Settings > AI Brains shows which ones are not available.'
        : result.error.message)
    } catch (e) {
      setState('failed')
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="rounded-md border border-border p-3 text-sm" data-testid="generate-summary-panel">
      <p className="text-muted-foreground">This transcript has no summary, title or meeting choice yet.</p>
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" onClick={() => void run()} disabled={state === 'running'}>
          {state === 'running' ? 'Writing the summary…' : state === 'failed' ? 'Try again' : 'Generate summary'}
        </Button>
        {message && <span className="text-xs text-destructive" role="alert">{message}</span>}
      </div>
    </div>
  )
}
