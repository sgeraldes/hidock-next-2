import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { WorkingValue } from '@/components/ui/working'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { formatBytes, cn } from '@/lib/utils'
import type { StorageInfo } from '@/types'
import type { SettingsSectionId } from './sections'
import { appLocale } from '@/lib/locale'

interface ConnectorLine {
  label: string
  state: string
}

type Tone = 'ok' | 'attention' | 'off'

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  attention: 'bg-amber-500',
  off: 'bg-muted-foreground/40'
}

type OverviewConfig = ReturnType<typeof useConfigStore.getState>['config']

/** Ready means the same as what the save accepts for that provider (Settings.tsx). */
export function transcriptionReady(t: NonNullable<OverviewConfig>['transcription'] | undefined): boolean {
  if (!t) return false
  const provider = t.provider || 'gemini'
  if (provider === 'gemini') return !!t.geminiApiKey?.trim()
  if (!t.localAsrPath?.trim()) return false
  if (provider === 'local-asr' && t.localAsrDiarize !== false && !t.localAsrHfToken?.trim()) return false
  return true
}

/** Jev is on only when its switch and at least one job are on, and a key is saved. */
export function jevStatus(config: OverviewConfig): { value: string; detail: string; tone: Tone } {
  const hasKey = !!config?.transcription.jevApiKey?.trim()
  const d = config?.decisions
  const enabled = d?.jevEnabled !== false
  const jobs = [d?.jevValue !== false && 'rates recordings', d?.jevMeetingMatch !== false && 'links meetings'].filter(
    (j): j is string => !!j
  )
  if (!enabled || jobs.length === 0) return { value: 'Off', detail: 'Turned off in Decisions (Jev)', tone: 'off' }
  if (!hasKey) return { value: 'Off', detail: 'Add a key to turn it on', tone: 'off' }
  const text = jobs.join(' and ')
  return { value: 'On', detail: text.charAt(0).toUpperCase() + text.slice(1), tone: 'ok' }
}

/**
 * Settings overview: one tile per area with its state in words, each opening
 * the page that changes it.
 */
export function OverviewSection({
  storageInfo,
  onNavigate
}: {
  storageInfo: StorageInfo | null
  onNavigate: (id: SettingsSectionId) => void
}) {
  const config = useConfigStore((s) => s.config)
  const [connectors, setConnectors] = useState<ConnectorLine[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI?.connectors
    if (!api?.list) return
    api
      .list()
      .then((list: Array<{ label: string; status: { state: string } }>) => {
        if (!cancelled) setConnectors(list.map((c) => ({ label: c.label, state: c.status.state })))
      })
      .catch(() => {
        if (!cancelled) setConnectors([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const provider = config?.transcription.provider || 'gemini'
  const providerLabel = provider === 'gemini' ? 'Gemini' : provider === 'vibevoice' ? 'VibeVoice' : 'Local ASR'
  const providerReady = transcriptionReady(config?.transcription)
  const jev = jevStatus(config)
  const connected = connectors?.filter((c) => c.state === 'connected') ?? []
  const needsSetup = connectors?.filter((c) => c.state !== 'connected') ?? []

  const tiles: Array<{ id: SettingsSectionId; title: string; value: ReactNode; detail: ReactNode; tone: Tone }> = [
    {
      id: 'transcription',
      title: 'Transcription',
      value: providerLabel,
      detail: providerReady ? 'Ready' : 'Needs setup',
      tone: providerReady ? 'ok' : 'attention'
    },
    {
      id: 'decisions',
      title: 'Decisions (Jev)',
      value: jev.value,
      detail: jev.detail,
      tone: jev.tone
    },
    {
      id: 'connectors',
      title: 'Connectors',
      value: connectors === null ? <WorkingValue label="Checking the connectors" className="w-28" /> : `${connected.length} connected`,
      detail:
        connectors === null
          ? <WorkingValue label="Checking the connectors" className="w-40" />
          : needsSetup.length > 0
            ? `${needsSetup.map((c) => c.label).join(', ')} need setup`
            : connected.map((c) => c.label).join(', ') || 'None set up',
      tone: connectors === null ? 'off' : needsSetup.length > 0 ? 'attention' : connected.length > 0 ? 'ok' : 'off'
    },
    {
      id: 'features',
      title: 'Features',
      value: presetLabel(config?.features?.preset),
      detail: 'Which parts of HiDock are on',
      tone: 'ok'
    },
    {
      id: 'storage',
      title: 'On this computer',
      value: storageInfo ? formatBytes(storageInfo.totalSizeBytes) : <WorkingValue label="Measuring storage" className="w-24" />,
      detail: storageInfo
        ? `Recordings, transcripts and the database · ${storageInfo.recordingsCount.toLocaleString(appLocale())} recordings`
        : <WorkingValue label="Measuring storage" className="w-40" />,
      tone: 'ok'
    },
    {
      id: 'maintenance',
      title: 'Maintenance',
      value: 'Jobs',
      detail: 'Rescan, re-check warnings, relink, waveforms, health check',
      tone: 'off'
    }
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="settings-overview">
      {tiles.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onNavigate(t.id)}
          className="group flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
        >
          <span className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className={cn('h-2 w-2 rounded-full', TONE_DOT[t.tone])} aria-hidden="true" />
              {t.title}
            </span>
            <ChevronRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
          </span>
          <span className="text-2xl font-semibold tabular-nums">{t.value}</span>
          <span className="truncate text-xs text-muted-foreground">{t.detail}</span>
        </button>
      ))}
    </div>
  )
}

function presetLabel(preset: string | undefined): string {
  switch (preset) {
    case 'library-only':
      return 'Library only'
    case 'library-transcription':
      return 'Library + transcription'
    case 'custom':
      return 'Custom'
    default:
      return 'Everything'
  }
}
