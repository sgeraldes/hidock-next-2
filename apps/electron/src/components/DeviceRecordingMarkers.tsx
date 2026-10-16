import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AddRecordingMarkerRequest, DeviceRecordingMarkersAPI, MarkerSubject, RecordingMarker } from '../shared/device-recording-markers'

export interface DeviceRecordingMarkersProps {
  subject: MarkerSubject
  durationMs?: number
  /** Current playhead in milliseconds; omit for active sessions to use their owner's clock. */
  atMs?: number
  onSeek?: (atMs: number) => void
  nativeImportAvailable?: boolean
}
function timestamp(atMs: number): string {
  const milliseconds = Math.floor(atMs % 1000).toString().padStart(3, '0')
  const seconds = Math.floor(atMs / 1000)
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}.${milliseconds}`
}

/** Receives only a recording/session ID. App-scoped shortcut works only within this focused panel. */
export function DeviceRecordingMarkers({ subject, durationMs, atMs, onSeek, nativeImportAvailable = false }: DeviceRecordingMarkersProps): JSX.Element {
  const [markers, setMarkers] = useState<RecordingMarker[]>([])
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const pending = useRef<AddRecordingMarkerRequest | null>(null)
  const generation = useRef(0)
  const api = (window.electronAPI as unknown as { deviceRecordingMarkers?: DeviceRecordingMarkersAPI })?.deviceRecordingMarkers
  const subjectKind = subject.kind
  const subjectId = subject.id
  const canAdd = subject.kind === 'session' || (typeof atMs === 'number' && Number.isInteger(atMs) && atMs >= 0 && (durationMs === undefined || atMs <= durationMs))

  useEffect(() => {
    const current = ++generation.current
    setLoading(true); setBusy(false); setError(''); setMessage(''); setMarkers([]); setEnabled(false); setLabel(''); pending.current = null
    if (!api) { setError('Marker controls are unavailable.'); setLoading(false); return }
    const selectedSubject = { kind: subjectKind, id: subjectId }
    Promise.all([api.list(selectedSubject), api.getSettings(selectedSubject)]).then(([items, settings]) => {
      if (generation.current !== current) return
      setMarkers(items); setEnabled(settings.automationEnabled)
    }).catch(() => { if (generation.current === current) setError('Could not load recording markers.') })
      .finally(() => { if (generation.current === current) setLoading(false) })
    return () => { generation.current = current + 1 }
    // Identity is deliberate: callers may construct a new subject object on each render.
  }, [subjectKind, subjectId, api])

  async function add(source: 'manual' | 'shortcut'): Promise<void> {
    if (!api || busy || loading || !canAdd) return
    const current = generation.current
    const request = pending.current ?? {
      subject: { ...subject }, requestId: crypto.randomUUID(), source, target: 'local' as const,
      ...(atMs !== undefined ? { atMs } : {}), ...(label.trim() ? { label: label.trim() } : {})
    }
    pending.current = request
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api.add(request)
      if (generation.current !== current) return
      if (result.status === 'accepted-local' || result.status === 'duplicate') {
        if (result.marker) setMarkers(items => [...items.filter(item => item.id !== result.marker!.id), result.marker!].sort((a, b) => a.atMs - b.atMs))
        pending.current = null; setLabel(''); setMessage('Marker saved locally.')
      } else {
        pending.current = null
        setError(result.reason ?? ({ full: 'Marker capacity reached.', inactive: 'Recording session is no longer active.', invalid: 'Choose a timestamp within the recording.', unsupported: 'Device marker insertion is unavailable.', 'automation-disabled': 'Automatic annotations are disabled.', 'rate-limited': 'Automatic annotations must be ten seconds apart.' }[result.status]))
      }
    } catch { if (generation.current === current) setError('Could not confirm the save. Retry uses the same marker ID.') }
    finally { if (generation.current === current) setBusy(false) }
  }

  async function importNative(): Promise<void> {
    if (!api || busy || loading) return
    const current = generation.current
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api.importNative(subject)
      const items = await api.list(subject)
      if (generation.current !== current) return
      setMarkers(items)
      setMessage(result.status === 'imported' ? `Imported ${result.markers.length} native-file markers.` : result.status === 'absent' ? 'No native marker trailer found.' : 'Native marker import is unavailable for this recording.')
    } catch { if (generation.current === current) setError('Could not import native recording markers.') }
    finally { if (generation.current === current) setBusy(false) }
  }

  async function toggleAutomation(): Promise<void> {
    if (!api || busy || loading) return
    const current = generation.current
    setBusy(true); setError('')
    try {
      const result = await api.setAutomation(subject, !enabled)
      if (generation.current === current) setEnabled(result.enabled)
      const items = await api.list(subject)
      if (generation.current === current) setMarkers(items)
    } catch { if (generation.current === current) setError('Could not change automatic annotations.') }
    finally { if (generation.current === current) setBusy(false) }
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm' && !event.repeat) {
      event.preventDefault(); event.stopPropagation(); void add('shortcut')
    }
  }

  return <section aria-label="Recording markers" tabIndex={0} onKeyDown={onKeyDown} className="rounded-lg border border-border p-3 space-y-3 text-sm">
    <div><h3 className="font-medium">Recording markers</h3>
      <p className="text-xs text-muted-foreground">New annotations are saved locally. Import reads markers already present in the recording file.</p></div>
    {loading ? <p role="status">Loading markers…</p> : <>
      <div className="flex flex-wrap gap-2 items-center">
        <input aria-label="Marker label" placeholder="Optional label" maxLength={512} value={label} disabled={busy || !!pending.current} onChange={event => setLabel(event.target.value)} className="rounded border bg-background px-2 py-1" />
        <button type="button" disabled={busy || !canAdd || !api} onClick={() => void add('manual')} className="rounded border px-2 py-1">{pending.current ? 'Retry marker' : 'Add marker'}</button>
        {subject.kind === 'recording' && <button type="button" disabled={busy || !api || !nativeImportAvailable} onClick={() => void importNative()} className="rounded border px-2 py-1">Import device markers</button>}
      </div>
      {!canAdd && <p className="text-xs text-muted-foreground">Choose a playback position to add a marker.</p>}
      <p className="text-xs text-muted-foreground">Ctrl+Shift+M adds a local marker while this panel has focus.</p>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={enabled} disabled={busy || !api} onChange={() => void toggleAutomation()} />Automatic annotations</label>
      <p className="text-xs text-muted-foreground">Off by default. Existing action/decision events can create local annotations at least 10 seconds apart, up to 80 automatic entries. The 100-entry addition limit reserves 20 for explicit marks.</p>
      {markers.length === 0 ? <p className="text-muted-foreground">No recording markers.</p> : <ol className="space-y-1">
        {markers.map(marker => <li key={marker.id} className="flex items-center gap-2">
          {onSeek ? <button type="button" onClick={() => onSeek(marker.atMs)} aria-label={`Seek to marker at ${timestamp(marker.atMs)}`} className="font-mono underline">{timestamp(marker.atMs)}</button> : <span className="font-mono">{timestamp(marker.atMs)}</span>}
          <span>{marker.label || 'Marker'}</span><span className="text-xs text-muted-foreground">{marker.persistence === 'native-file' ? 'Imported native file' : 'Local annotation'} · {marker.source}</span>
        </li>)}
      </ol>}
    </>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

/** Trusted export takes a recording ID; main chooses the destination and preserves the source. */
export function DeviceRecordingTrackExport({ recordingId }: { recordingId: string }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [tracks, setTracks] = useState<Array<{ channelId: string; path: string }>>([])
  async function exportTracks(): Promise<void> {
    if (busy) return
    setBusy(true); setMessage(''); setError(''); setTracks([])
    try {
      const result = await window.electronAPI.deviceAudio.exportTracks(recordingId)
      setTracks(result.tracks)
      setMessage(`Exported ${result.tracks.length} synchronized channel tracks at ${result.sampleRate} Hz. Source identities remain unverified.`)
    } catch (cause) {
      setError(cause instanceof Error && /cancel/i.test(cause.message) ? 'Track export cancelled.' : 'Could not export WAV tracks.')
    } finally { setBusy(false) }
  }
  return <div className="space-y-1 text-xs">
    <button type="button" disabled={busy || !window.electronAPI?.deviceAudio} onClick={() => void exportTracks()} className="rounded border px-2 py-1">{busy ? 'Exporting WAV tracks…' : 'Export WAV tracks'}</button>
    <p className="text-muted-foreground">Exports each PCM16 WAV channel to a separate synchronized file.</p>
    {tracks.length > 0 && <ul aria-label="Exported channel files" className="space-y-1">{tracks.map(track => <li key={track.channelId}><span>{track.channelId}: </span><span className="select-text break-all font-mono">{track.path}</span></li>)}</ul>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </div>
}
