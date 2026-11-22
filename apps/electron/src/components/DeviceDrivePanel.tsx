import { useEffect, useRef, useState } from 'react'
import { Copy, HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface DriveStatus {
  mounted: boolean
  drive: string | null
  readOnly: true
  windowsFileLimitBytes: number | null
}

function checkedStatus(value: DriveStatus): DriveStatus {
  if (!value || value.readOnly !== true || typeof value.mounted !== 'boolean' ||
    (value.mounted && (typeof value.drive !== 'string' || !/^[A-Z]:$/.test(value.drive))) ||
    (value.windowsFileLimitBytes !== null && (!Number.isSafeInteger(value.windowsFileLimitBytes) || value.windowsFileLimitBytes <= 0))) {
    throw Error('Invalid drive status')
  }
  return { ...value, drive: value.mounted ? value.drive : null }
}

function safeError(cause: unknown, action: string): string {
  const message = cause instanceof Error ? cause.message : ''
  const known = message.match(/(?:Drive mapping is available on Windows|No unused drive letter is available|Device filesystem is unavailable|Windows could not map the device drive(?: \(error \d{1,6}\))?|Windows could not unmap the device drive|The drive mapping changed outside HiDock; it was preserved)$/)?.[0]
  return known ?? `Could not ${action} the device drive. Try again when the device is idle.`
}

/** Manual mapping only. Route changes never unmount another window's drive. */
export function DeviceDrivePanel({ connected }: { connected: boolean }): JSX.Element | null {
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const generation = useRef(0)
  const operationPending = useRef(false)
  const api = window.electronAPI?.jensen

  useEffect(() => {
    const current = ++generation.current
    setStatus(null); setError(''); setMessage(''); setLoading(connected)
    if (!connected) return
    if (!api?.getDeviceDriveStatus) { setLoading(false); return }
    void api.getDeviceDriveStatus().then(value => {
      if (generation.current === current) setStatus(checkedStatus(value))
    }).catch(cause => {
      if (generation.current === current) setError(safeError(cause, 'read the status of'))
    }).finally(() => { if (generation.current === current) setLoading(false) })
    return () => { generation.current = current + 1 }
  }, [connected, api, refreshVersion])

  async function changeMount(mount: boolean): Promise<void> {
    if (!api || !connected || loading || operationPending.current) return
    operationPending.current = true
    const current = generation.current
    setBusy(true); setError(''); setMessage('')
    try {
      const result = checkedStatus(await (mount ? api.mountDeviceDrive() : api.unmountDeviceDrive()))
      if (generation.current !== current) return
      setStatus(result)
      if (mount && !result.mounted) setError('Windows did not mount the device drive. Try again when the device is idle.')
      else if (!mount && result.mounted) setError('The drive is still mounted. Try unmounting again.')
      else setMessage(result.mounted ? 'Drive mounted read-only.' : 'Drive unmounted.')
    } catch (cause) {
      if (generation.current === current) setError(safeError(cause, mount ? 'mount' : 'unmount'))
    } finally {
      operationPending.current = false
      setBusy(false)
      // A reconnect may have read status before the preceding operation settled.
      if (generation.current !== current) setRefreshVersion(value => value + 1)
    }
  }

  async function copyPath(): Promise<void> {
    if (!status?.mounted || !status.drive) return
    const current = generation.current
    try {
      await navigator.clipboard.writeText(`${status.drive}\\`)
      if (generation.current === current) setMessage('Drive path copied. Paste it into File Explorer’s address bar.')
    } catch {
      if (generation.current === current) setError('Could not copy the drive path. Select it and copy it manually.')
    }
  }

  if (!connected || !api?.mountDeviceDrive || !api?.unmountDeviceDrive || !api?.getDeviceDriveStatus) return null
  return <Card role="region" aria-label="Device drive">
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><HardDrive aria-hidden="true" className="h-5 w-5" />Device drive</CardTitle>
      <CardDescription>Browse and copy recordings in Windows File Explorer. Device files are read-only.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {loading ? <p role="status" className="text-sm">Checking drive status…</p> : status?.mounted ? <>
          <span className="font-mono text-lg select-text" aria-label="Mounted drive path">{status.drive}\</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyPath()} disabled={busy}>
            <Copy aria-hidden="true" className="h-4 w-4 mr-2" />Copy drive path
          </Button>
        </> : <p className="text-sm text-muted-foreground">Not mounted</p>}
        <Button type="button" size="sm" variant={status?.mounted ? 'outline' : 'default'} disabled={loading || busy}
          aria-busy={busy || undefined} onClick={() => void changeMount(!status?.mounted)}>
          {busy ? status?.mounted ? 'Unmounting…' : 'Mounting…' : status?.mounted ? 'Unmount drive' : 'Mount drive'}
        </Button>
      </div>
      {status?.mounted && <>
        <p className="text-sm text-muted-foreground">Open File Explorer and enter the drive path above. Copy files to a local folder.</p>
        <p className="text-xs text-muted-foreground">
          {status.windowsFileLimitBytes === null ? 'The Windows per-file copy limit is unavailable.' :
            `Windows per-file copy limit: ${status.windowsFileLimitBytes.toLocaleString('en-US')} bytes.`}
          {' '}For larger recordings, use Download in this app’s device file list.
        </p>
      </>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </CardContent>
  </Card>
}
