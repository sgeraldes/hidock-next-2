import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { BusyIcon } from '@/components/ui/working'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from '@/components/ui/toaster'

type Job = 'rescan' | 'warnings' | 'relink' | 'match' | 'waveforms'

/**
 * Library maintenance: one button per job that repairs or refreshes what the
 * Library shows (owner, 28-sep-2026). Each row says what the job does, what it
 * costs, and the result of its last run.
 */
export function LibraryMaintenanceCard({
  onRescanWithJev,
  rescanAvailable,
  rescanRunning
}: {
  /** Marks every evaluation outdated and starts the value scan (Settings owns the scan state). */
  onRescanWithJev: () => Promise<void>
  rescanAvailable: boolean
  rescanRunning: boolean
}) {
  const [busy, setBusy] = useState<Job | null>(null)
  const [results, setResults] = useState<Partial<Record<Job, string>>>({})
  const api = window.electronAPI.maintenance

  const runJob = async (job: Job, fn: () => Promise<string>) => {
    setBusy(job)
    try {
      const text = await fn()
      setResults((r) => ({ ...r, [job]: text }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setResults((r) => ({ ...r, [job]: `Failed: ${message}` }))
      toast.error('Maintenance failed', message)
    } finally {
      setBusy(null)
    }
  }

  const unwrap = <T,>(res: { success: boolean; data?: T; error?: { message?: string } | string }): T => {
    if (res.success && res.data !== undefined) return res.data
    const err = res.error
    throw new Error(typeof err === 'string' ? err : err?.message || 'The job did not finish.')
  }

  // `running`: the job keeps going after its start call returns (the rescan), so the spinner stays until it ends.
  const rows: Array<{ job: Job; title: string; detail: string; action: string; disabled?: boolean; running?: boolean; run: () => Promise<string> }> = [
    {
      job: 'rescan',
      title: 'Rescan with Jev',
      detail:
        'Evaluates every recording again: stars, kind, work or personal, transcript trust. About 2,000 requests, a few minutes and a few cents. Ratings you set are never changed.',
      action: 'Rescan all',
      disabled: !rescanAvailable || rescanRunning,
      running: rescanRunning,
      run: async () => {
        await onRescanWithJev()
        return 'Started. Progress shows in the Find low-value recordings card.'
      }
    },
    {
      job: 'warnings',
      title: 'Re-check warnings',
      detail:
        'Works out the audio-versus-transcript warnings again from the stored audio check and transcripts. Local, a second or two.',
      action: 'Re-check',
      run: async () => {
        const r = unwrap(await api.recheckWarnings())
        return `${r.changed} of ${r.evaluated} warnings changed.`
      }
    },
    {
      job: 'relink',
      title: 'Relink recordings to meetings',
      detail:
        'Pulls your Microsoft 365 calendar back to the oldest recording, then links every recording with no meeting to the meeting it overlaps. Links you set stay as they are.',
      action: 'Relink',
      run: async () => {
        const r = unwrap(await api.relinkMeetings())
        const history = r.accounts === 0 ? ' No Microsoft 365 account is connected, so only meetings already here were used.' : ` ${r.meetingsSynced} meetings synced.`
        const errors = r.errors.length > 0 ? ` Problems: ${r.errors.join('; ')}` : ''
        return `${r.linked} recordings linked. ${r.unlinkedAfter} of ${r.unlinkedBefore} still have no meeting.${history}${errors}`
      }
    },
    {
      job: 'match',
      title: 'Match meetings with Jev',
      detail:
        'For each recording with two or more possible meetings, Jev reads what was said against each meeting subject and attendees, and links the clear answers. Sends a transcript excerpt and the meeting list to api.typesafe.ai. Links you set stay as they are.',
      action: 'Match',
      disabled: !rescanAvailable,
      run: async () => {
        const r = unwrap(await api.matchMeetings())
        const auth = r.stoppedOnAuth ? ' Stopped: Jev rejected the key.' : ''
        return `${r.linked} linked, ${r.relinked} moved to a better meeting, ${r.noMatch} match none of their meetings. Jev asked ${r.asked} times (${r.reused} answers reused).${auth}`
      }
    },
    {
      job: 'waveforms',
      title: 'Redraw waveforms',
      detail:
        'Draws a quick waveform for every recording from its stored audio check, with no decoding. The exact waveform replaces it the first time you play the recording.',
      action: 'Redraw',
      run: async () => {
        const r = unwrap(await api.redrawWaveforms())
        return `${r.drawn} drawn, ${r.keptExact} already exact, ${r.noEnvelope} without an audio check.`
      }
    }
  ]

  return (
    <Card data-testid="library-maintenance">
      <CardHeader>
        <CardTitle>Library maintenance</CardTitle>
        <CardDescription>Jobs that refresh what the Library shows. Each one works on data already on this computer unless it says otherwise.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        {rows.map((row) => {
          const working = busy === row.job || !!row.running
          return (
          <div key={row.job} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 max-w-prose">
              <p className="text-sm font-medium">{row.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{row.detail}</p>
              {results[row.job] && (
                <p className="mt-1 text-xs" aria-live="polite" data-testid={`maintenance-result-${row.job}`}>
                  {results[row.job]}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => runJob(row.job, row.run)}
              disabled={busy !== null || row.disabled}
              aria-label={row.title}
              aria-busy={working || undefined}
              title={working ? (row.job === 'rescan' ? 'Scanning' : 'Working') : undefined}
            >
              {working && <BusyIcon className="mr-1.5" />}
              {row.action}
            </Button>
          </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
