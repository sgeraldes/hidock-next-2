/**
 * Small controls for values the config had but nothing edited (settings map,
 * 28-sep-2026): the Ollama chat and embedding models, and the CPU share the
 * speaker worker may use. Each saves on its own.
 */
import { useEffect, useRef, useState } from 'react'
import { REMOTE_ASR_MODELS, REMOTE_ASR_LABELS } from '@/shared/asr-models'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'

function TextField({ id, label, hint, value, onSave }: { id: string; label: string; hint: string; value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim()
    if (!v) {
      toast.error(`${label} cannot be empty`)
      setDraft(value)
      return
    }
    if (v !== value) onSave(v)
  }
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  )
}

export function OllamaModelFields() {
  const chatModel = useConfigStore((s) => s.config?.chat?.ollamaModel) ?? 'llama3.2'
  const embedModel = useConfigStore((s) => s.config?.embeddings?.ollamaModel) ?? 'nomic-embed-text'
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const save = (section: 'chat' | 'embeddings', v: string) =>
    void updateConfig(section, { ollamaModel: v } as never).catch((err: unknown) =>
      toast.error('Could not change the Ollama model', err instanceof Error ? err.message : undefined)
    )
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField id="ollamaChatModel" label="Ollama chat model" hint="The model that answers, as named in Ollama." value={chatModel} onSave={(v) => save('chat', v)} />
      <TextField
        id="ollamaEmbedModel"
        label="Ollama embedding model"
        hint="Used for search when Ollama embeds. Changing it needs a re-index."
        value={embedModel}
        onSave={(v) => save('embeddings', v)}
      />
    </div>
  )
}

const CPU_CHOICES = Array.from({ length: 19 }, (_, index) => 10 + index * 5)

export function DiarizationCpuShare() {
  const value = useConfigStore((s) => s.config?.transcription?.speakerLinkingCpuPercent) ?? 50
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const [logicalCores, setLogicalCores] = useState<number | null>(null)
  const priority = useConfigStore((s) => s.config?.transcription?.localComputePriority) ?? 'below-normal'
  const accelerator = useConfigStore((s) => s.config?.transcription?.localComputeAccelerator) ?? 'auto'
  const concurrency = useConfigStore((s) => s.config?.transcription?.maxConcurrentRecordings) ?? 1
  const pauseBattery = useConfigStore((s) => s.config?.transcription?.pauseLocalOnBattery) !== false
  const pauseBusy = useConfigStore((s) => s.config?.transcription?.pauseLocalWhenBusy) !== false
  const localFallback = useConfigStore((s) => s.config?.transcription?.modelHostLocalFallback) === true
  const idleSeconds = useConfigStore((s) => s.config?.transcription?.localModelIdleSeconds) ?? 60
  useEffect(() => {
    let active = true
    void window.electronAPI?.speakers?.getSetup().then((result) => {
      if (active && result.success) setLogicalCores(result.data.hardware.cpu.logicalCores)
    }).catch(() => { /* A missing measurement is not a guessed CPU count. */ })
    return () => { active = false }
  }, [])
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor="diarizationCpuShare" className="text-sm font-medium">
          CPU share for local processing
        </label>
        <p className="mt-1 text-xs text-muted-foreground">Shared by local transcription, speaker identification and indexing.</p>
        <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
          {value}%{logicalCores ? ` · ${Math.max(1, Math.floor(logicalCores * value / 100))} of ${logicalCores} logical processors` : ''}
          {' · Applies to the next stage.'}
        </p>
      </div>
      <select
        id="diarizationCpuShare"
        className="rounded-md border border-input bg-background px-2 py-1 text-sm"
        value={value}
        onChange={(e) =>
          void updateConfig('transcription', { speakerLinkingCpuPercent: Number(e.target.value) } as never).catch((err: unknown) =>
            toast.error('Could not change the CPU share', err instanceof Error ? err.message : undefined)
          )
        }
      >
        {[...new Set([...CPU_CHOICES, value])].sort((a, b) => a - b).map((c) => (
          <option key={c} value={c}>
            {c}%
          </option>
        ))}
      </select>
      <div className="flex w-full items-center justify-between gap-3">
        <label htmlFor="localModelIdle" className="text-sm">Unload idle local models</label>
        <select id="localModelIdle" className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={idleSeconds} onChange={(event) => {
            void updateConfig('transcription', { localModelIdleSeconds: Number(event.target.value) })
              .catch(() => toast.error('Could not change idle timeout'))
          }}>
          <option value={0}>Immediately</option><option value={30}>After 30 seconds</option>
          <option value={60}>After 1 minute</option><option value={300}>After 5 minutes</option>
          <option value={600}>After 10 minutes</option>
        </select>
      </div>
      <div className="flex w-full items-center justify-between gap-3">
        <label htmlFor="localPriority" className="text-sm">Local process priority</label>
        <select id="localPriority" className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={priority} onChange={(event) => {
            void updateConfig('transcription', { localComputePriority: event.target.value as 'low' | 'below-normal' | 'normal' })
              .catch(() => toast.error('Could not change priority'))
          }}>
          <option value="low">Low</option><option value="below-normal">Below normal · Balanced</option><option value="normal">Normal</option>
        </select>
      </div>
      <div className="flex w-full items-center justify-between gap-3">
        <label htmlFor="localAccelerator" className="text-sm">Local accelerator</label>
        <select id="localAccelerator" className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={accelerator} onChange={(event) => {
            void updateConfig('transcription', { localComputeAccelerator: event.target.value as 'auto' | 'cpu' })
              .catch(() => toast.error('Could not change accelerator'))
          }}>
          <option value="auto">Auto · supported runtime device</option><option value="cpu">CPU only</option>
        </select>
      </div>
      <div className="flex w-full items-center justify-between gap-3">
        <label htmlFor="transcriptionConcurrency" className="text-sm">Concurrent recordings</label>
        <select id="transcriptionConcurrency" className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={concurrency} onChange={(event) => {
            void updateConfig('transcription', { maxConcurrentRecordings: Number(event.target.value) as 1 | 2 })
              .catch(() => toast.error('Could not change concurrency'))
          }}>
          <option value={1}>1 · Balanced</option><option value={2}>2 · Cloud / remote overlap</option>
        </select>
      </div>
      <label className="flex w-full items-center gap-2 text-sm">
        <input type="checkbox" checked={localFallback} onChange={(event) => {
          void updateConfig('transcription', { modelHostLocalFallback: event.target.checked })
            .catch(() => toast.error('Could not change the fallback policy'))
        }} />
        Allow local processing when the remote worker is unavailable
      </label>
      {([
        ['pauseLocalOnBattery', pauseBattery, 'Pause local models on battery power'],
        ['pauseLocalWhenBusy', pauseBusy, 'Wait while other CPU work exceeds 80%'],
      ] as const).map(([key, checked, label]) => <label key={key} className="flex w-full items-center gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={(event) => {
          void updateConfig('transcription', { [key]: event.target.checked })
            .catch(() => toast.error('Could not change resource policy'))
        }} />{label}
      </label>)}
      <p className="w-full text-xs text-muted-foreground">
        Local models share one processing slot. Changes apply after the current stage.
        {' '}To apply now, use “Restart local stage with current CPU limit” in the processing monitor.
      </p>
    </div>
  )
}


export function AudioExecutionSettings({ provider }: { provider?: string }) {
  const config = useConfigStore(s => s.config?.transcription)
  const updateConfig = useConfigStore(s => s.updateConfig)
  const [testing, setTesting] = useState(false)
  const [savingModel, setSavingModel] = useState(false)
  const [result, setResult] = useState('')
  const [readyModels, setReadyModels] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const [paired, setPaired] = useState(false)
  const [prepareModel, setPrepareModel] = useState<string>(REMOTE_ASR_MODELS[0])
  const [preparing, setPreparing] = useState(false)
  const requestVersion = useRef(0)
  const remoteSelected = (provider || config?.provider) === 'remote-worker'
  const refreshModels = async () => {
    const version = ++requestVersion.current
    setChecking(true); setReadyModels([]); setPaired(false)
    try {
      const response = await window.electronAPI.modelHost.status()
      if (version !== requestVersion.current) return
      const status = response.success ? response.status : undefined
      const health = status?.health as ({ asrModels?: unknown } | null | undefined)
      const models = status?.paired && Array.isArray(health?.asrModels)
        ? health.asrModels.filter((model): model is string => typeof model === 'string') : []
      setPaired(status?.paired === true)
      setReadyModels(models)
    } catch { /* Remain unavailable until authenticated host status succeeds. */ }
    finally { if (version === requestVersion.current) setChecking(false) }
  }
  useEffect(() => {
    setReadyModels([]); setPaired(false)
    if (remoteSelected) void refreshModels()
    // A request counter, not a DOM node: bumping the latest value cancels in-flight answers.
    const counter = requestVersion
    return () => { counter.current++ }
  }, [remoteSelected, config?.modelHostUrl])
  if (!config || ['gemini', 'muse-voice', 'mai-transcribe-2'].includes(provider || config.provider)) return null
  const remoteDefault = (provider || config.provider) === 'remote-worker'
  const audio8LanguageUnsupported = remoteDefault && config.remoteAsrModel === 'Edge0/Audio8-ASR-Infinite'
    && !['en', 'zh'].includes((config.language || 'auto').toLowerCase().replace('_', '-').split('-')[0])
  return <div className="space-y-2 rounded-md border border-border p-3">
    {remoteDefault && <div className="flex items-center gap-3">
      <label htmlFor="remoteAsrModel" className="text-sm">Remote transcription model</label>
      <select id="remoteAsrModel" className="max-w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
        value={config.remoteAsrModel || ''} disabled={savingModel || testing} onChange={event => {
          if (event.target.value ? !readyModels.includes(event.target.value) : !readyModels.length) return
          setResult('')
          setSavingModel(true)
          void updateConfig('transcription', { remoteAsrModel: event.target.value })
            .then(() => setResult('Saved. The worker must have prepared and validated this model.'))
            .catch(() => setResult('Could not save model.'))
            .finally(() => setSavingModel(false))
        }}>
        <option value="" disabled={!readyModels.length}>Worker default · {readyModels.length ? 'ready' : 'unavailable'}</option>
        {REMOTE_ASR_MODELS.map(model => <option key={model} value={model} disabled={!readyModels.includes(model)}>
          {REMOTE_ASR_LABELS[model]} · {readyModels.includes(model) ? 'ready' : 'unavailable'}
        </option>)}
      </select>
    </div>}
    {remoteDefault && <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Only models advertised by the paired host can be selected. Your saved selection is kept when unavailable.</p>
      <button type="button" disabled={checking || preparing} onClick={() => void refreshModels()} className="rounded border border-input px-2 py-1 text-sm">
        {checking ? 'Checking models…' : 'Refresh available models'}
      </button>
      <label htmlFor="prepareRemoteAsr" className="ml-3 text-sm">Prepare on host</label>
      <select id="prepareRemoteAsr" value={prepareModel} disabled={preparing} onChange={event => setPrepareModel(event.target.value)} className="max-w-full rounded border border-input bg-background px-2 py-1 text-sm">
        {REMOTE_ASR_MODELS.map(model => <option key={model} value={model}>{REMOTE_ASR_LABELS[model]}</option>)}
      </select>
      <button type="button" disabled={!paired || checking || preparing} className="rounded border border-input px-2 py-1 text-sm" onClick={async () => {
        setPreparing(true); setResult('Preparing the selected model on the host…')
        try {
          const response = await window.electronAPI.modelHost.prepareAsr({ model: prepareModel as typeof REMOTE_ASR_MODELS[number] })
          setResult(response.success ? 'Host preparation started. Refresh available models after host validation finishes.' : 'Host preparation could not start. Check the host setup status.')
          await refreshModels()
        } catch { setResult('Could not prepare the model on the host.') }
        finally { setPreparing(false) }
      }}>{preparing ? 'Preparing…' : 'Prepare model'}</button>
      {!paired && !checking && <p className="text-xs text-muted-foreground">Pair a model host in remote processing settings to prepare models.</p>}
    </div>}
    <label htmlFor="audioExecution" className="text-sm font-medium">Transcription execution</label>
    <select id="audioExecution" className="ml-3 rounded-md border border-input bg-background px-2 py-1 text-sm"
      value={remoteDefault ? 'remote' : config.transcriptionExecution || 'local'} disabled={remoteDefault}
      onChange={event => { setResult(''); void updateConfig('transcription', {
        transcriptionExecution: event.target.value as 'local' | 'remote' | 'auto'
      }).then(() => setResult('Saved. Applies to the next transcription.')).catch(() => setResult('Could not save execution location.')) }}>
      <option value="local">This computer</option><option value="remote">Remote worker</option>
      <option value="auto">Auto · prefer remote</option>
    </select>
    <div className="flex items-center gap-3">
      <label htmlFor="audioLanguage" className="text-sm">Audio language</label>
      <input id="audioLanguage" maxLength={4} className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
        value={config.language || 'auto'} placeholder="es" onChange={event => {
          void updateConfig('transcription', { language: event.target.value.toLowerCase() })
            .catch(() => setResult('Could not save language.'))
        }} />
      <span className="text-xs text-muted-foreground">Language code, e.g. es or en. Cohere requires an explicit language.</span>
    </div>
    {audio8LanguageUnsupported && <p role="alert" className="text-sm text-amber-500">
      Audio8 supports English and Chinese only. Choose en or zh before testing or transcribing; automatic language and Spanish are unsupported.
    </p>}
    <p className="text-xs text-muted-foreground">Remote failures pause processing. Auto can use this computer only when local fallback is enabled. Existing remote jobs are resumed without starting a local duplicate.</p>
    <button type="button" disabled={testing || savingModel || audio8LanguageUnsupported} className="rounded-md border border-input px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring"
      onClick={async () => { setTesting(true); try {
        const response = await window.electronAPI.modelHost.testAudio({ provider: provider || config.provider })
        setResult(response.success && response.route
          ? `${response.route.execution} · ${response.route.model}. ${response.route.execution === 'remote' ? `${response.route.host || 'Remote worker'} · last validated device: ${response.route.lastValidatedDevice || 'not reported'}. Authenticated engine capability confirmed.` : 'Selected route; no model was loaded.'}`
          : response.error || 'Capability test failed')
      } catch { setResult('Capability test failed') } finally { setTesting(false) } }}>
      {testing ? 'Testing…' : 'Test selected route'}
    </button>
    <p role="status" aria-live="polite" className="text-sm">{result}</p>
  </div>
}
