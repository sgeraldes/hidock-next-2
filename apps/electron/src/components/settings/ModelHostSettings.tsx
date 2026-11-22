/**
 * The machine with the GPU.
 *
 * This computer has an AMD card, so diarization runs on its CPU and a backlog
 * takes hours. The Model Host runs the same worker on the gamestation's RTX
 * card and hands the result back. Pairing is the only thing this panel does;
 * whether a recording actually goes there is decided per recording in the main
 * process, and a host that is off changes nothing.
 */

import { useState } from 'react'
import { REMOTE_ASR_MODELS, REMOTE_ASR_LABELS } from '@/shared/asr-models'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { toast } from '@/components/ui/toaster'
import { ModelHostStatusLine } from './ModelHostStatusLine'

type StepAside = 'any-use' | 'games' | 'never'

const STEP_ASIDE_CHOICES: Array<{ value: StepAside; label: string }> = [
  { value: 'any-use', label: 'Step aside whenever it is used' },
  { value: 'games', label: 'Step aside only for games' },
  { value: 'never', label: 'Never step aside' }
]

type Health = NonNullable<
  Awaited<ReturnType<NonNullable<typeof window.electronAPI>['modelHost']['check']>>['health']
>

export function ModelHostSettings(): React.ReactElement {
  const { config, updateConfig } = useConfigStore()
  const savedUrl = config?.transcription?.modelHostUrl ?? ''
  const paired = Boolean(config?.transcription?.modelHostToken)

  const [url, setUrl] = useState(savedUrl)
  const [code, setCode] = useState('')
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)
  const [asrModel, setAsrModel] = useState<(typeof REMOTE_ASR_MODELS)[number]>('CohereLabs/cohere-transcribe-03-2026')
  const [preparationMessage, setPreparationMessage] = useState('')
  const [preparingRole, setPreparingRole] = useState<'semantic' | 'realtime' | 'generation' | null>(null)
  const [stepAside, setStepAside] = useState<StepAside>(config?.transcription?.modelHostStepAside ?? 'games')

  const check = async () => {
    setBusy(true)
    setHealth(null)
    try {
      const result = await window.electronAPI.modelHost.check({ url })
      if (!result.success || !result.health) {
        if (preparingRole) setPreparationMessage('Host unavailable while preparation or reconnection is pending. Check again after it restarts; readiness is not confirmed.')
        toast.error('No host there', result.error)
        return
      }
      setHealth(result.health)
      if (preparingRole) {
        const ready = preparingRole === 'semantic' ? result.health.semanticEmbedding?.ready === true
          : preparingRole === 'generation' ? result.health.textGeneration?.ready === true
          : result.health.realtimeAsrModels?.includes('nvidia/nemotron-3.5-asr-streaming-0.6b') === true
        setPreparationMessage(ready ? 'Host reconnected and this role is ready. Select the role explicitly to use it; defaults are unchanged.'
          : 'Host reconnected, but this role is unavailable or has not passed validation. Review its preparation log on the host.')
        setPreparingRole(null)
      }
    } finally {
      setBusy(false)
    }
  }

  const prepareRole = async (role: 'semantic' | 'realtime' | 'generation') => {
    setBusy(true)
    setPreparationMessage('Requesting role preparation...')
    try {
      const result = await window.electronAPI.modelHost.prepareRole({ role })
      if (result.success) {
        setPreparingRole(role); setHealth(null)
        setPreparationMessage('Preparation accepted. The host stops temporarily and reconnects after validation. Press Check after it restarts; readiness is not confirmed yet. Defaults are unchanged.')
      } else setPreparationMessage(result.error || 'Role preparation could not start.')
    } catch { setPreparationMessage('No preparation acknowledgement received. Check the host before retrying; preparation may already be running.') }
    finally { setBusy(false) }
  }

  const pair = async () => {
    setBusy(true)
    try {
      const result = await window.electronAPI.modelHost.pair({ url, code })
      if (!result.success) {
        toast.error('Could not pair', result.error)
        return
      }
      setCode('')
      if (result.warning) toast.error('Paired, with a problem', result.warning)
      else toast.success('Paired', 'The host got the Hugging Face token and is testing the voice model.')
    } finally {
      setBusy(false)
    }
  }

  const changeStepAside = async (value: StepAside) => {
    setStepAside(value)
    const result = await window.electronAPI.modelHost.setStepAside({ value })
    if (!result.success) toast.error('Could not save it', result.error)
    else if (!result.sent && paired) {
      toast.success('Saved', 'The host is not answering; it gets the change the next time you press Check.')
    }
  }

  const forget = async () => {
    setBusy(true)
    try {
      await window.electronAPI.modelHost.forget()
      setUrl('')
      setHealth(null)
      toast.success('Forgotten', 'The host is disconnected. Local processing follows your Transcription settings.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model host</CardTitle>
        <CardDescription>
          Another computer on your network that runs transcription and speaker models. If it is unavailable,
          remote work pauses. Local fallback runs only when enabled in Transcription settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {savedUrl && <ModelHostStatusLine />}
        {paired && <div className="space-y-2">
          <label htmlFor="host-asr-engine" className="text-sm font-medium">Prepare transcription on this host</label>
          <div className="flex flex-wrap gap-2">
            <select id="host-asr-engine" value={asrModel} disabled={busy}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={event => setAsrModel(event.target.value as typeof asrModel)}>
              {REMOTE_ASR_MODELS.map(model => <option key={model} value={model}>{REMOTE_ASR_LABELS[model]}</option>)}
            </select>
            <Button variant="outline" disabled={busy || preparingRole !== null} onClick={async () => {
              setBusy(true)
              setPreparationMessage('Requesting preparation…')
              try {
                const result = await window.electronAPI.modelHost.prepareAsr({ model: asrModel })
                setPreparationMessage(result.success
                  ? 'Preparation started on the host. It will be temporarily offline and reconnect after the model test.'
                  : result.error || 'Preparation could not start.')
              } catch { setPreparationMessage('Could not reach the host. Check its connection before retrying.') }
              finally { setBusy(false) }
            }}>Prepare engine</Button>
          </div>
          <p className="text-xs text-muted-foreground">Downloads model files on the remote computer. Requires an idle host and can take several minutes. Your default transcription service stays selected.</p>
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-medium">Prepare additional host roles</p>
            <p className="text-xs text-muted-foreground">Requires an idle paired host. Preparation temporarily stops the host. These actions do not select a provider or change your defaults.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy || preparingRole !== null} onClick={() => void prepareRole('semantic')}>Prepare semantic search</Button>
              <Button variant="outline" disabled={busy || preparingRole !== null} onClick={() => void prepareRole('realtime')}>Prepare realtime transcription</Button>
              <Button variant="outline" disabled={busy || preparingRole !== null} onClick={() => void prepareRole('generation')}>Prepare text generation (about 5.7 GB)</Button>
            </div>
            <p className="text-xs text-muted-foreground">Semantic search requires the exact imported ONNX assets in the host&apos;s models/nemotron-3-embed-1b folder. Missing assets must be imported there; this action does not download them.</p>
            <p className="text-xs text-muted-foreground">Realtime validates the prepared Nemotron streaming runtime. Text generation downloads about 5.7 GB on the host when its model is missing, then validates it.</p>
            {health && <p className="text-xs text-muted-foreground">Last Check: semantic search {health.semanticEmbedding?.ready ? 'ready' : 'unavailable or not reported'}; realtime {health.realtimeAsrModels?.includes('nvidia/nemotron-3.5-asr-streaming-0.6b') ? 'ready' : 'unavailable or not reported'}; text generation {health.textGeneration?.ready ? 'ready' : 'unavailable or not reported'}.</p>}
          </div>
          {preparationMessage && <p role="status" className="text-sm">{preparationMessage}</p>}
        </div>}
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="model-host-url">
            Host address
          </label>
          <div className="flex gap-2">
            <Input
              id="model-host-url"
              value={url}
              placeholder="https://gamestation:8766"
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button variant="outline" onClick={check} disabled={busy || !url.trim()}>
              Check
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The name or address of the machine, and the port shown on its control page.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="model-host-certificate">Host certificate</label>
          <Input id="model-host-certificate" type="file" accept=".pem,.cer" disabled={busy}
            onChange={async event => {
              const file = event.target.files?.[0]
              if (!file) return
              try {
                if (file.size > 32768) throw new Error('Certificate exceeds 32 KB')
                const pem = await file.text()
                if (!pem.includes('-----BEGIN CERTIFICATE-----') || pem.includes('PRIVATE KEY')) {
                  throw new Error('Select the public host-certificate.pem file, not a private key.')
                }
                await updateConfig('transcription', { modelHostCertificatePem: pem })
                toast.success('Host certificate saved', 'Trust applies only to HiDock model-host requests.')
              } catch (error) { toast.error('Certificate not saved', String(error)) }
            }} />
          <p className="text-xs text-muted-foreground">
            Copy host-certificate.pem directly from the server you control. Importing it authorizes that
            certificate for this connection. Publicly trusted certificates need no import.
          </p>
          {config?.transcription.modelHostCertificatePem && <Button variant="outline"
            onClick={() => void updateConfig('transcription', { modelHostCertificatePem: '' })}>Remove certificate trust</Button>}
        </div>

        {health && (
          <div className="rounded-md border border-border p-3 text-sm">
            <p>
              Host {health.version}, {health.state}
              {health.reason ? `. ${health.reason}` : ''}
            </p>
            <p className="text-muted-foreground">
              {health.gpu === undefined
                ? 'Pair with this host to see what hardware it has.'
                : health.gpu === null
                  ? 'No NVIDIA driver answered there. Only models explicitly reported ready can run.'
                  : `${health.gpu.name}, driver ${health.gpu.driver}`}
            </p>
            {health.capabilities.length === 0 && (
              <p className="text-muted-foreground">
                Setup has not finished on that machine, so it cannot diarize yet.
              </p>
            )}
          </div>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <label className="text-sm font-medium" htmlFor="model-host-code">
            Pairing code
          </label>
          <div className="flex gap-2">
            <Input
              id="model-host-code"
              value={code}
              placeholder="Empty, or the code from the host"
              inputMode="numeric"
              disabled={busy}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 12))}
            />
            <Button onClick={pair} disabled={busy || !url.trim() || (code.length > 0 && code.length < 4)}>
              Pair
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            For five minutes after it is installed, the host accepts the first HiDock with no code: leave
            it empty. Otherwise, on the host, right-click its tray icon and choose Pairing &gt; Show a
            pairing code. Pairing also gives the host this computer&rsquo;s Hugging Face token.
          </p>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <label className="text-sm font-medium" htmlFor="model-host-step-aside">
            When the gamestation is in use
          </label>
          <select
            id="model-host-step-aside"
            className="block rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={stepAside}
            onChange={(event) => void changeStepAside(event.target.value as StepAside)}
          >
            {STEP_ASIDE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Stepping aside pauses the host&apos;s processing. Remote work waits; local fallback is allowed only
            when enabled in Transcription settings and no remote job remains active. The host resumes
            five minutes after the game closes, or after the last key press when it steps aside for any use.
            Its tray icon can also pause it by hand.
          </p>
        </div>

        {paired && (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">
              This computer is paired with {savedUrl || 'a model host'}.
            </p>
            <Button variant="outline" onClick={forget} disabled={busy}>
              Forget this host
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
