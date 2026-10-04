/**
 * Settings > Player & notifications: skip length, the speeds on offer, the
 * starting speed and how long notices stay. Each change saves on its own.
 */
import { useConfigStore } from '@/store/domain/useConfigStore'
import { toast } from '@/components/ui/toaster'
import { ALLOWED_PLAYBACK_SPEEDS, playerPreferences, speedLabel } from '@/lib/player-preferences'
import { cn } from '@/lib/utils'

const SKIP_CHOICES = [5, 10, 15, 30]
const TOAST_CHOICES = [3, 5, 8, 12]

export function PlayerSection() {
  const ui = useConfigStore((s) => s.config?.ui)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const prefs = playerPreferences(ui as never)

  const save = (values: Record<string, unknown>) => {
    void updateConfig('ui', values as never).catch((err: unknown) =>
      toast.error('Could not save the player settings', err instanceof Error ? err.message : undefined)
    )
  }

  const toggleSpeed = (speed: number) => {
    if (speed === 1) return // 1× always stays on offer
    const next = prefs.playbackSpeeds.includes(speed)
      ? prefs.playbackSpeeds.filter((s) => s !== speed)
      : [...prefs.playbackSpeeds, speed].sort((a, b) => a - b)
    const values: Record<string, unknown> = { playbackSpeeds: next }
    if (!next.includes(prefs.defaultPlaybackSpeed)) values.defaultPlaybackSpeed = 1
    save(values)
  }

  return (
    <div className="space-y-4" data-testid="settings-player">
      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Player</h3>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="skipSeconds" className="text-sm">
            Back and forward buttons jump
          </label>
          <select
            id="skipSeconds"
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={prefs.skipSeconds}
            onChange={(e) => save({ skipSeconds: Number(e.target.value) })}
          >
            {[...new Set([...SKIP_CHOICES, prefs.skipSeconds])].sort((a, b) => a - b).map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <p className="text-sm">Speeds in the speed menu</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Speeds in the speed menu">
            {ALLOWED_PLAYBACK_SPEEDS.map((speed) => {
              const on = prefs.playbackSpeeds.includes(speed)
              return (
                <button
                  key={speed}
                  type="button"
                  aria-pressed={on}
                  disabled={speed === 1}
                  onClick={() => toggleSpeed(speed)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent',
                    speed === 1 && 'cursor-default'
                  )}
                >
                  {speedLabel(speed)}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="defaultPlaybackSpeed" className="text-sm">
            Recordings start at
          </label>
          <select
            id="defaultPlaybackSpeed"
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={prefs.defaultPlaybackSpeed}
            onChange={(e) => save({ defaultPlaybackSpeed: Number(e.target.value) })}
          >
            {prefs.playbackSpeeds.map((s) => (
              <option key={s} value={s}>
                {speedLabel(s)}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Notifications</h3>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="toastSeconds" className="text-sm">
            Notices stay on screen for
          </label>
          <select
            id="toastSeconds"
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={prefs.toastSeconds}
            onChange={(e) => save({ toastSeconds: Number(e.target.value) })}
          >
            {[...new Set([...TOAST_CHOICES, prefs.toastSeconds])].sort((a, b) => a - b).map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">Notices that need an answer, like Undo, keep their own time.</p>
      </section>
    </div>
  )
}
