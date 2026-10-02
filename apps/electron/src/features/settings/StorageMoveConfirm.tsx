/**
 * Shown under a storage folder after a new path is chosen: what changing it
 * means, and the choice. Nothing changes until a button is pressed.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { BusyIcon } from '@/components/ui/working'
import { formatBytes } from '@/lib/utils'
import { appLocale } from '@/lib/locale'
import { useConfigStore } from '@/store/domain/useConfigStore'
import type { StorageMovePlan } from '@/types'

interface Props {
  plan: StorageMovePlan
  /** The change was applied (or the data folder was switched); reload paths and usage. */
  onDone: () => void
  onCancel: () => void
}

export function StorageMoveConfirm({ plan, onDone, onCancel }: Props) {
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const [busy, setBusy] = useState<'move' | 'switch' | null>(null)
  const [progress, setProgress] = useState<{ copiedFiles: number; totalFiles: number; copiedBytes: number } | null>(null)
  const [restartNeeded, setRestartNeeded] = useState(false)

  useEffect(() => {
    const off = window.electronAPI?.storage?.onMoveProgress?.((p) => {
      if (p.folder === plan.folder) setProgress(p)
    })
    return () => off?.()
  }, [plan.folder])

  const count = `${plan.files.toLocaleString(appLocale())} files (${formatBytes(plan.bytes)})`

  if (plan.folder === 'data') {
    if (restartNeeded) {
      return (
        <div className="mt-2 space-y-2 rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs" role="status">
          <p>Saved. HiDock opens the library in the new folder the next time it starts.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => window.electronAPI?.app?.restart()}>
              Restart now
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>
              Later
            </Button>
          </div>
        </div>
      )
    }
    return (
      <div className="mt-2 space-y-2 rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs" role="alertdialog" aria-label="Change the data folder">
        <p>
          The data folder holds the library database. {plan.targetHasDatabase
            ? 'The new folder already has a HiDock library; HiDock will open that one.'
            : 'The new folder has no library; HiDock will start an empty one there.'}{' '}
          The current library stays in {plan.from} and nothing is copied.
        </p>
        {plan.blocker && <p className="text-destructive">{plan.blocker}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!!plan.blocker}
            onClick={async () => {
              try {
                await updateConfig('storage', { dataPath: plan.to })
                setRestartNeeded(true)
              } catch (err) {
                toast.error('Could not change the data folder', err instanceof Error ? err.message : undefined)
              }
            }}
          >
            {plan.targetHasDatabase ? 'Use that library' : 'Start an empty library there'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Keep the current folder
          </Button>
        </div>
      </div>
    )
  }

  const run = async (mode: 'move' | 'switch') => {
    setBusy(mode)
    try {
      const api = window.electronAPI.storage
      const result =
        mode === 'move'
          ? await api.moveFolder?.(plan.folder as 'recordings', plan.to, { files: plan.files, bytes: plan.bytes })
          : await api.switchFolder?.(plan.folder as 'recordings', plan.to)
      if (!result?.success) throw new Error(result?.error ?? 'The folder was not changed')
      const cancelled = mode === 'move' && (result as { data?: { cancelled: boolean } }).data?.cancelled
      if (cancelled) {
        toast.info('Move stopped', 'Nothing was switched, and the partial copy was removed.')
      } else {
        toast.success(mode === 'move' ? 'Folder moved' : 'Folder switched', mode === 'move' ? `The originals are still in ${plan.from}; delete them when you are sure.` : undefined)
      }
      onDone()
    } catch (err) {
      toast.error('Could not change the folder', err instanceof Error ? err.message : undefined)
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded border border-border bg-background p-3 text-xs" role="alertdialog" aria-label={`Change the ${plan.folder} folder`}>
      <p>
        {plan.files > 0 ? `${count} are in ${plan.from}.` : `${plan.from} is empty.`}{' '}
        {plan.targetFreeBytes !== null && `The new disk has ${formatBytes(plan.targetFreeBytes)} free.`}

      </p>
      {plan.blocker && <p className="text-destructive">{plan.blocker}</p>}
      {progress && (
        <div className="space-y-1" aria-live="polite">
          <p>
            Copying {progress.copiedFiles.toLocaleString(appLocale())} of {progress.totalFiles.toLocaleString(appLocale())} ·{' '}
            {formatBytes(progress.copiedBytes)}
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${progress.totalFiles ? (progress.copiedFiles / progress.totalFiles) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!!plan.blocker || busy !== null || plan.files === 0}
          onClick={() => void run('move')}
          aria-busy={busy === 'move' || undefined}
          title={busy === 'move' ? 'Moving' : undefined}
        >
          {busy === 'move' && <BusyIcon className="mr-1.5" />}
          {`Move ${count} and switch`}
        </Button>
        {plan.canSwitchWithoutMoving && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('switch')}>
            Use the new folder
          </Button>
        )}
        {busy === 'move' ? (
          <Button size="sm" variant="ghost" onClick={() => void window.electronAPI.storage.cancelMove?.()}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <p className="text-muted-foreground">
        Moving pauses downloads and transcription, copies every file, checks each copy, then points HiDock at the new
        folder. The originals stay until you delete them.
      </p>
    </div>
  )
}
