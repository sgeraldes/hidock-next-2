import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/toaster'

const DEFAULT_ADDRESS = 'http://localhost:1234/v1'

interface Connection {
  baseUrl: string
  model: string
  embeddingModel: string
}

const trimmedOf = (connection: Connection): Connection => ({
  baseUrl: connection.baseUrl.trim(),
  model: connection.model.trim(),
  embeddingModel: connection.embeddingModel.trim()
})

function Field({
  id,
  label,
  hint,
  children
}: {
  id: string
  label: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      {children}
      <p className="text-[13px] text-muted-foreground">{hint}</p>
    </div>
  )
}

/**
 * The connection of a local server that speaks the OpenAI protocol (LM Studio, llama.cpp, vLLM): where it
 * is, which models to ask for, and an optional key. It sits on the AI providers page because it is not a
 * choice of model (that is the Pipeline page) but how to reach an engine, like a key for Gemini. The key
 * goes to the credential store and is never read back: the page only learns that one is stored.
 */
export function OpenAiCompatibleCard({ onSaved }: { onSaved: () => void }) {
  const [saved, setSaved] = useState<Connection>({ baseUrl: DEFAULT_ADDRESS, model: '', embeddingModel: '' })
  const [draft, setDraft] = useState<Connection>(saved)
  const [hasKey, setHasKey] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [savingConnection, setSavingConnection] = useState(false)
  const [savingKey, setSavingKey] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const current = await window.electronAPI.brains.getOpenAiCompatible()
        if (!live) return
        const connection = { baseUrl: current.baseUrl, model: current.model, embeddingModel: current.embeddingModel }
        setSaved(connection)
        setDraft(connection)
        setHasKey(current.hasKey)
      } catch {
        /* keep the defaults: the fields still work, and saving writes the real values */
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const trimmed = trimmedOf(draft)
  const changed = trimmed.baseUrl !== saved.baseUrl || trimmed.model !== saved.model || trimmed.embeddingModel !== saved.embeddingModel

  const saveConnection = useCallback(async () => {
    const next = trimmedOf(draft)
    setSavingConnection(true)
    try {
      const result = await window.electronAPI.brains.setOpenAiCompatible(next)
      if (!result.success) {
        toast.error(result.error ?? 'The connection could not be saved.')
        return
      }
      setSaved(next)
      setDraft(next)
      toast.success('Connection saved.')
      onSaved()
    } catch (e) {
      toast.error(`The connection could not be saved: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSavingConnection(false)
    }
  }, [draft, onSaved])

  const saveKey = async (value: string | null) => {
    setSavingKey(true)
    try {
      await window.electronAPI.brains.setCredential({ id: 'openai-compatible', field: 'apiKey', value })
      setHasKey(value !== null)
      setKeyDraft('')
      toast.success(value === null ? 'Key removed.' : 'Key saved.')
      onSaved()
    } catch (e) {
      toast.error(`The key could not be saved: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-border p-4" aria-label="Local server (OpenAI-compatible)">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Local server (OpenAI-compatible)</h3>
        <p className="text-sm text-muted-foreground">
          Where HiDock finds LM Studio, llama.cpp or vLLM. Turn the provider on above, then choose it for a step in
          Settings &gt; Pipeline.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="oai-address" label="Address" hint="Include /v1, for example http://localhost:1234/v1.">
          <Input
            id="oai-address"
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field id="oai-model" label="Model" hint="Leave empty to use the model the server has loaded.">
          <Input
            id="oai-model"
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field id="oai-embedding" label="Embedding model" hint="Leave empty if the server has none.">
          <Input
            id="oai-embedding"
            value={draft.embeddingModel}
            onChange={(e) => setDraft({ ...draft, embeddingModel: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          id="oai-key"
          label="API key"
          hint={hasKey ? 'Key saved, encrypted on this computer.' : 'Optional. Most local servers need none.'}
        >
          <div className="flex gap-2">
            <Input
              id="oai-key"
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={hasKey ? 'Replace the saved key' : ''}
              autoComplete="off"
            />
            <Button variant="outline" disabled={savingKey || keyDraft.trim() === ''} onClick={() => void saveKey(keyDraft.trim())}>
              Save key
            </Button>
            {hasKey && (
              <Button variant="ghost" disabled={savingKey} onClick={() => void saveKey(null)}>
                Remove key
              </Button>
            )}
          </div>
        </Field>
      </div>

      <div>
        <Button disabled={!changed || savingConnection} onClick={() => void saveConnection()}>
          Save connection
        </Button>
      </div>
    </section>
  )
}
