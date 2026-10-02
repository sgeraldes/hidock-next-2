/**
 * Settings > Storage: the space each location takes, the free space on its
 * disk, an optional limit, and the connected HiDock's own storage (owner,
 * 28-sep-2026). The folder pickers stay in the Storage card; these lines sit
 * under each one.
 */
import { useCallback, useEffect, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { useAppStore } from '@/store/useAppStore'
import { toast } from '@/components/ui/toaster'
import { Working } from '@/components/ui/working'
import { formatBytes, cn } from '@/lib/utils'
import { appLocale } from '@/lib/locale'
import type { StorageLocationUsage } from '@/types'

export function useStorageUsage(): { usage: StorageLocationUsage[] | null; reload: () => void } {
  const [usage, setUsage] = useState<StorageLocationUsage[] | null>(null)
  const reload = useCallback(() => {
    const api = window.electronAPI?.storage?.getUsage
    if (!api) return
    void api().then((r) => {
      if (r?.success && r.data) setUsage(r.data)
    })
  }, [])
  useEffect(() => reload(), [reload])
  return { usage, reload }
}

export function StorageUsageLine({ usage, onLimitSaved }: { usage: StorageLocationUsage | undefined; onLimitSaved: () => void }) {
  const limits = useConfigStore((s) => s.config?.storage?.limitsGB)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const id = usage?.id
  const saved = id ? limits?.[id] ?? null : null
  const [draft, setDraft] = useState(saved ? String(saved) : '')
  useEffect(() => setDraft(saved ? String(saved) : ''), [saved])

  if (!usage || !id) return <Working label="Measuring the folder" shape="lines" rows={1} className="mt-1 py-1" />

  const saveLimit = () => {
    const value = draft.trim() === '' ? null : Number(draft)
    if (value !== null && (!Number.isFinite(value) || value <= 0)) {
      toast.error('The limit must be a number of GB, or empty for no limit')
      return
    }
    if (value === saved) return
    void updateConfig('storage', { limitsGB: { ...(limits ?? {}), [id]: value } } as never)
      .then(onLimitSaved)
      .catch((err: unknown) => toast.error('Could not save the limit', err instanceof Error ? err.message : undefined))
  }

  if (usage.error) {
    return (
      <p className="mt-1.5 text-xs text-destructive" data-testid={`storage-usage-${id}`}>
        Could not measure this folder: {usage.error}.{id === 'recordings' && usage.limitBytes ? ' Automatic downloads pause until it can be read.' : ''}
      </p>
    )
  }
  const usedShare = usage.limitBytes ? Math.min(1, usage.bytes / usage.limitBytes) : null
  return (
    <div className="mt-1.5 space-y-1 text-xs" data-testid={`storage-usage-${id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <span className={cn('font-medium text-foreground', usage.overLimit && 'text-destructive')}>
          {formatBytes(usage.bytes)} · {usage.files.toLocaleString(appLocale())} files
        </span>
        {usage.disk && (
          <span>
            Disk: {formatBytes(usage.disk.freeBytes)} free of {formatBytes(usage.disk.totalBytes)}
          </span>
        )}
        <label className="ml-auto flex items-center gap-1.5">
          Limit
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveLimit}
            onKeyDown={(e) => e.key === 'Enter' && saveLimit()}
            inputMode="decimal"
            placeholder="none"
            aria-label={`Limit for ${id} in GB`}
            className="w-16 rounded border border-input bg-background px-1.5 py-0.5 text-right"
          />
          GB
        </label>
      </div>
      {usedShare !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className={cn('h-full', usage.overLimit ? 'bg-destructive' : 'bg-primary')} style={{ width: `${usedShare * 100}%` }} />
        </div>
      )}
      {usage.overLimit && (
        <p className="text-destructive">
          Over the limit.{id === 'recordings' ? ' Auto-download is paused until there is room again.' : ''}
        </p>
      )}
    </div>
  )
}

/** The connected HiDock's storage; nothing when no device is connected. */
export function DeviceStorageCard() {
  const deviceState = useAppStore((s) => s.deviceState)
  if (!deviceState?.connected || !deviceState.storage || deviceState.storage.capacity <= 0) return null
  const { capacity, used } = deviceState.storage
  return (
    <div className="space-y-2 rounded bg-muted/50 p-3 text-sm" data-testid="device-storage">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">HiDock (connected)</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatBytes(used)} used · {formatBytes(capacity - used)} free of {formatBytes(capacity)} ·{' '}
        {deviceState.recordingCount.toLocaleString(appLocale())} recordings on the device
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full bg-primary" style={{ width: `${Math.min(100, (used / capacity) * 100)}%` }} />
      </div>
    </div>
  )
}
