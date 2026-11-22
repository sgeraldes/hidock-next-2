import { useState } from 'react'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { isSavedSecret } from '@/shared/secret-fields'

/** Credentials are write-only; saved values are renderer redaction markers. */
export function CloudAsrSettings() {
  const config = useConfigStore(s => s.config?.transcription)
  const update = useConfigStore(s => s.updateConfig)
  const [muse, setMuse] = useState('')
  const [mai, setMai] = useState('')
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const configured = (value?: string) => isSavedSecret(value) || !!value?.trim()
  const save = async () => {
    setBusy(true); setMessage('')
    try {
      const nextEndpoint = endpoint ?? config?.maiTranscribeEndpoint ?? ''
      if (nextEndpoint) {
        const url = new URL(nextEndpoint)
        if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(url.hostname)
            || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
          throw new Error('Use the Azure Speech resource origin: https://resource.cognitiveservices.azure.com')
        }
      }
      await update('transcription', {
        ...(muse.trim() ? { museVoiceApiKey: muse.trim() } : {}),
        ...(mai.trim() ? { maiTranscribeApiKey: mai.trim() } : {}),
        maiTranscribeEndpoint: nextEndpoint
      })
      setMuse(''); setMai(''); setMessage('Saved. Provider access has not been tested; select the service in Pipeline.')
    } catch { setMessage('Could not save. Check the Azure Speech HTTPS origin and try again.') }
    finally { setBusy(false) }
  }
  return <section aria-label="Additional cloud transcription" className="space-y-4 rounded-xl border border-border p-4">
    <h3 className="text-sm font-semibold">Muse Voice and MAI Transcribe 2 · cloud</h3>
    <p className="text-xs text-muted-foreground">Audio is uploaded to Meta or Azure. Recordings are sent sequentially in clips of up to ten minutes. Speaker labels apply within each clip; identities are not merged across clips. These services are separate from Gamestation.</p>
    <label className="block text-sm">Meta Model API key · {configured(config?.museVoiceApiKey) ? 'Saved, not verified' : 'Not configured'}
      <input type="password" autoComplete="off" value={muse} onChange={e => setMuse(e.target.value)} placeholder="Enter or replace key" className="mt-1 block w-full rounded border bg-background p-2" />
    </label>
    <label className="block text-sm">Azure Speech key · {configured(config?.maiTranscribeApiKey) ? 'Saved, not verified' : 'Not configured'}
      <input type="password" autoComplete="off" value={mai} onChange={e => setMai(e.target.value)} placeholder="Enter or replace key" className="mt-1 block w-full rounded border bg-background p-2" />
    </label>
    <label className="block text-sm">Azure Speech resource origin
      <input type="url" value={endpoint ?? config?.maiTranscribeEndpoint ?? ''} onChange={e => setEndpoint(e.target.value)} placeholder="https://resource.cognitiveservices.azure.com" className="mt-1 block w-full rounded border bg-background p-2" />
    </label>
    <button type="button" disabled={busy} onClick={() => void save()} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">{busy ? 'Saving…' : 'Save cloud credentials'}</button>
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </section>
}
