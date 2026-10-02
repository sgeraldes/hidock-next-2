import { useEffect, useState } from 'react'
import type { StorageInfo } from '@/types'
import { WorkingValue } from '@/components/ui/working'

interface AppInfo {
  version: string
  name: string
  isPackaged: boolean
  platform: string
}

/** Version and where HiDock keeps its data. */
export function AboutSection({ storageInfo }: { storageInfo: StorageInfo | null }) {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.app
      ?.info()
      .then((i: AppInfo) => {
        if (!cancelled) setInfo(i)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const rows: Array<[string, string | null]> = [
    ['Version', info ? `${info.name} ${info.version}${info.isPackaged ? '' : ' (development build)'}` : null],
    ['Platform', info?.platform ?? null],
    ['Data folder', storageInfo?.dataPath ?? null],
    ['Database', storageInfo?.databasePath ?? null],
    ['Cache', storageInfo?.cachePath ?? null]
  ]

  return (
    <dl className="divide-y divide-border rounded-lg border border-border bg-card" data-testid="settings-about">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
          <dt className="text-sm font-medium">{label}</dt>
          <dd className="min-w-0 break-all text-right font-mono text-xs text-muted-foreground">
            {value ?? <WorkingValue label={`Reading the ${label.toLowerCase()}`} className="w-32" />}
          </dd>
        </div>
      ))}
    </dl>
  )
}
