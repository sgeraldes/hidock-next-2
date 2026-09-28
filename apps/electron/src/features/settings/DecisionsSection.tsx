import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { cn } from '@/lib/utils'

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

type JobKey = 'jevValue' | 'jevMeetingMatch' | 'jevSpeakerNames'

const JOBS: Array<{
  key: JobKey | null
  title: string
  sends: string
  decides: string
  storedAs: string
}> = [
  {
    key: 'jevValue',
    title: 'Rate recordings and check transcripts',
    sends:
      'A transcript excerpt (the beginning, middle and end, up to 8,000 characters), the summary, the meeting subject, and the audio check numbers (length, seconds of sound, words).',
    decides:
      'Stars from 1 to 5, the kind of recording, work or personal, whether the transcript may be invented or too long for its audio, and whether it holds action items. One star rates a recording "no value"; two, "low value".',
    storedAs: 'recording evaluations'
  },
  {
    key: 'jevMeetingMatch',
    title: 'Match recordings to calendar meetings',
    sends:
      'A transcript excerpt (up to 3,300 characters), the summary, the recording time, and for each candidate meeting its subject, time, organizer and attendee names.',
    decides:
      'Which meeting the recording is, or none of them. A clear answer (70% or more, 25 points ahead of the next) links the recording; links you set are never changed.',
    storedAs: 'meeting matches'
  },
  {
    key: 'jevSpeakerNames',
    title: 'Name the speakers',
    sends:
      'For each unnamed speaker, up to four of their lines, lines where others mention names, the meeting subject, the summary, and the people who may be speaking: the invite list, the meeting contacts, and your organization when the meeting gives fewer than three names.',
    decides:
      'Which of those people each speaker is, or none. A clear answer (80% or more, 30 points ahead of the next) names the speaker; names you or a voice match set are never changed.',
    storedAs: 'speaker names'
  }
]

/**
 * Decisions (Jev): one switch for Jev, one per job, and in plain words what
 * each job sends and decides (the Kiro Crew Decisions page, owner 28-sep-2026).
 */
export function DecisionsSection() {
  const config = useConfigStore((s) => s.config)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const decisions = config?.decisions ?? { jevEnabled: true, jevValue: true, jevMeetingMatch: true }
  const hasKey = !!config?.transcription.jevApiKey?.trim()
  const jevOn = decisions.jevEnabled !== false

  const set = async (patch: Partial<typeof decisions>) => {
    try {
      await updateConfig('decisions', { ...decisions, ...patch })
    } catch (e) {
      toast.error('Could not save', e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-4" data-testid="settings-decisions">
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h3 className="text-sm font-semibold">Decisions (Jev)</h3>
            <p className="text-sm text-muted-foreground">
              Jev is a small, fast decision model from TypeSafe AI. With this on, HiDock asks Jev the questions of each
              job switched on below, instead of a larger AI model. Each job sends only the text it describes, over the
              internet, to Jev. Nothing is sent while this is off.
            </p>
            <p className="text-xs text-muted-foreground">
              Sent to <code className="rounded bg-muted px-1 py-0.5">{JEV_ENDPOINT}</code>
              {' · '}
              {hasKey ? 'Key saved (encrypted on this computer).' : 'No key yet: add one in the card below.'}
            </p>
          </div>
          <Switch
            checked={jevOn}
            onCheckedChange={(v) => set({ jevEnabled: v })}
            aria-label="Use Jev for decisions"
          />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card" aria-label="What Jev decides">
        <p className="border-b border-border px-4 py-3 text-sm font-semibold">What Jev decides while this is on</p>
        <ul className="divide-y divide-border">
          {JOBS.map((job) => {
            const on = job.key ? decisions[job.key] !== false : false
            const available = !!job.key && jevOn && hasKey
            return (
              <li key={job.title} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className={cn('min-w-0 space-y-1', !available && 'opacity-70')}>
                  <p className="text-sm font-medium">{job.title}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">Sends: </span>
                    {job.sends}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">Decides: </span>
                    {job.decides}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Stored as {job.storedAs}</p>
                </div>
                {job.key ? (
                  <Switch
                    checked={on}
                    disabled={!jevOn}
                    onCheckedChange={(v) => set({ [job.key as JobKey]: v })}
                    aria-label={job.title}
                  />
                ) : (
                  <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Planned</span>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
