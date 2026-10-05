import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { formatBytes } from '@/lib/utils'

type Stats = { consumers: { chat: number; explore: number; brain: number }; dropped_events: number; file_bytes: number }

export function RetrievalTraceSettings() {
  const { config, updateConfig } = useConfigStore()
  const [stats, setStats] = useState<Stats | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const recordQueries = config?.chat.recordQueries !== false
  const keepQueryText = config?.chat.keepQueryText !== false

  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const result = await window.electronAPI?.traces?.stats()
        if (!alive) return
        if (result?.success) { setStats(result.data); setFailure(null) }
        else setFailure('Query recording statistics could not be read. Reopen Settings to try again.')
      } catch {
        if (alive) setFailure('Query recording statistics could not be read. Reopen Settings to try again.')
      }
    }
    void read()
    return () => { alive = false }
  }, [recordQueries, keepQueryText])

  const save = async (values: { recordQueries?: boolean; keepQueryText?: boolean }) => {
    setSaving(true)
    try { await updateConfig('chat', values) }
    catch { setFailure('Query recording settings could not be saved. Try again.') }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="record-queries" className="text-sm font-medium">Record queries</label>
        <Switch id="record-queries" checked={recordQueries} disabled={saving} onCheckedChange={value => void save({ recordQueries: value })} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="keep-query-text" className="text-sm font-medium">Keep the text of my queries (encrypted, 30 days)</label>
        <Switch id="keep-query-text" checked={keepQueryText} disabled={saving} onCheckedChange={value => void save({ keepQueryText: value })} />
      </div>
      {failure ? <p role="alert" className="text-xs text-muted-foreground">{failure}</p> : (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {stats ? `Last 7 days: Chat ${stats.consumers.chat} · Explore ${stats.consumers.explore} · Brain ${stats.consumers.brain} · ${stats.dropped_events} dropped · ${formatBytes(stats.file_bytes)}` : 'Reading query recording statistics…'}
        </p>
      )}
    </div>
  )
}
