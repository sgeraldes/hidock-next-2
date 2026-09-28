/**
 * Small controls for values the config had but nothing edited (settings map,
 * 28-sep-2026): the Ollama chat and embedding models, and the CPU share the
 * speaker worker may use. Each saves on its own.
 */
import { useEffect, useState } from 'react'
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

const CPU_CHOICES = [25, 40, 50, 75]

export function DiarizationCpuShare() {
  const value = useConfigStore((s) => s.config?.transcription?.speakerLinkingCpuPercent) ?? 40
  const updateConfig = useConfigStore((s) => s.updateConfig)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor="diarizationCpuShare" className="text-sm font-medium">
          CPU share for speaker identification
        </label>
        <p className="mt-1 text-xs text-muted-foreground">Lower keeps the computer responsive while voices are matched; higher finishes sooner.</p>
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
    </div>
  )
}
