import { useEffect, useRef, useState } from 'react'
import { useConfigStore } from '@/store/domain/useConfigStore'

const PYANNOTE = 'pyannote/speaker-diarization-3.1'
const NATIVE = 'nvidia/Nemotron-3-Diarization'

export function RemoteDiarizationSettings() {
  const config = useConfigStore(s => s.config?.transcription)
  const update = useConfigStore(s => s.updateConfig)
  const [models, setModels] = useState<string[]>([])
  const [message, setMessage] = useState('Capabilities not checked')
  const [busy, setBusy] = useState(false)
  const requestVersion = useRef(0)
  const visible = !!config?.modelHostUrl && ['auto', 'model-host'].includes(config?.speakerEngine || 'auto')
  const refresh = async () => {
    const version = ++requestVersion.current
    setBusy(true); setModels([])
    try {
      const response = await window.electronAPI.modelHost.status()
      if (version !== requestVersion.current) return
      const available = response.success ? response.status.health?.diarizationModels ?? [] : []
      setModels(available)
      setMessage(available.length ? 'Showing prepared and validated host models.' : 'Host unavailable or no validated models advertised.')
    } catch { if (version === requestVersion.current) setMessage('Could not check host capabilities.') }
    finally { if (version === requestVersion.current) setBusy(false) }
  }
  useEffect(() => {
    setModels([])
    if (visible) void refresh()
    // A request counter, not a DOM node: bumping the latest value cancels in-flight answers.
    const counter = requestVersion
    return () => { counter.current++ }
  }, [visible, config?.modelHostUrl])
  if (!visible) return null
  return <section className="space-y-2 rounded-md border border-border p-3" aria-label="Remote speaker segmentation">
    <label htmlFor="remote-diarization-model" className="text-sm font-medium">Remote diarization model</label>
    <select id="remote-diarization-model" value={config?.remoteDiarizationModel || PYANNOTE}
      disabled={busy} className="ml-3 max-w-full rounded border border-input bg-background px-2 py-1 text-sm"
      onChange={event => {
        const selected = event.target.value
        if (!models.includes(selected)) return
        setBusy(true)
        void update('transcription', { remoteDiarizationModel: selected })
          .then(() => setMessage('Saved. Applies to the next speaker segmentation.'))
          .catch(() => setMessage('Could not save model.'))
          .finally(() => setBusy(false))
      }}>
      <option value={PYANNOTE} disabled={!models.includes(PYANNOTE)}>Pyannote 3.1 · default</option>
      <option value={NATIVE} disabled={!models.includes(NATIVE)}>Nemotron 3 · native segmentation</option>
    </select>
    <p className="text-xs text-muted-foreground">Nemotron separates speaker turns. It does not supply persistent voice identification; recognition remains a separate stage.</p>
    <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded border border-input px-2 py-1 text-sm">{busy ? 'Checking…' : 'Refresh speaker models'}</button>
    <p role="status" className="text-xs text-muted-foreground">{message}</p>
  </section>
}
