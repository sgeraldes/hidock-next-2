/**
 * Settings > Secrets: every stored credential in one list, set or not set,
 * with replace and remove (settings spec, phase 4). Values never reach the
 * window: config:get sends a "saved" marker, and a save returns the same.
 * AI-provider keys and connector secrets have their own pages, so they are
 * listed here with their status and a link.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { isSavedSecret } from '@/shared/secret-fields'
import type { SettingsSectionId } from './sections'

interface ConfigSecret {
  section: 'transcription' | 'calendar'
  key: string
  label: string
  usedFor: string
}

/** The secrets in config.json (SECRET_CONFIG_FIELDS in src/shared/secret-fields.ts). */
export const CONFIG_SECRETS: ConfigSecret[] = [
  { section: 'transcription', key: 'geminiApiKey', label: 'Google Gemini API key', usedFor: 'Transcription, analysis, chat and image descriptions.' },
  { section: 'transcription', key: 'localAsrHfToken', label: 'Hugging Face token', usedFor: 'Downloads the speaker-separation model.' },
  { section: 'transcription', key: 'jevApiKey', label: 'Jev API key', usedFor: 'Ratings, evaluations and meeting matching.' },
  { section: 'transcription', key: 'modelHostToken', label: 'Model host token', usedFor: 'The gamestation that lends its GPU over the network.' },
  { section: 'calendar', key: 'icsUrl', label: 'Calendar feed link (ICS)', usedFor: 'The private link to a published calendar.' }
]

function ConfigSecretRow({ secret, isSet }: { secret: ConfigSecret; isSet: boolean }) {
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const [mode, setMode] = useState<'idle' | 'replace' | 'confirm-remove'>('idle')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const id = `secret-${secret.key}`

  const save = async (value: string) => {
    setBusy(true)
    try {
      await updateConfig(secret.section, { [secret.key]: value } as never)
      toast.success(value ? `${secret.label} saved` : `${secret.label} removed`)
      setMode('idle')
      setDraft('')
    } catch (err) {
      toast.error(`Could not change the ${secret.label.toLowerCase()}`, err instanceof Error ? err.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 border-b border-border py-3 last:border-b-0" data-testid={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{secret.label}</p>
          <p className="text-xs text-muted-foreground">{secret.usedFor}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${isSet ? 'text-emerald-600' : 'text-muted-foreground'}`}>{isSet ? 'Set' : 'Not set'}</span>
          {mode === 'idle' && (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode('replace')}>
                {isSet ? 'Replace' : 'Add'}
              </Button>
              {isSet && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode('confirm-remove')} className="text-muted-foreground hover:text-red-600">
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {mode === 'replace' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim()) void save(draft.trim())
          }}
        >
          <label htmlFor={id} className="sr-only">
            New {secret.label.toLowerCase()}
          </label>
          <Input
            id={id}
            type="password"
            value={draft}
            autoFocus
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            placeholder={`Paste the new ${secret.label.toLowerCase()}`}
          />
          <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => { setMode('idle'); setDraft('') }}>
            Cancel
          </Button>
        </form>
      )}
      {mode === 'confirm-remove' && (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="alertdialog" aria-label={`Remove the ${secret.label.toLowerCase()}`}>
          <span>Remove it? What uses it stops working until a new one is added.</span>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void save('')}>
            Remove
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode('idle')}>
            Keep it
          </Button>
        </div>
      )}
    </div>
  )
}

interface OtherSecret {
  label: string
  isSet: boolean
  page: SettingsSectionId
  pageLabel: string
}

export function SecretsSection({ onNavigate }: { onNavigate?: (id: SettingsSectionId) => void }) {
  const config = useConfigStore((s) => s.config) as unknown as Record<string, Record<string, unknown> | undefined> | null
  const [others, setOthers] = useState<OtherSecret[] | null>(null)

  useEffect(() => {
    let live = true
    const load = async () => {
      const rows: OtherSecret[] = []
      try {
        const brains = (await window.electronAPI?.brains?.list?.()) ?? []
        for (const b of brains as Array<{ label: string; auth?: { configured?: boolean; method?: string } }>) {
          if (b.auth?.method === 'none') continue
          rows.push({ label: `${b.label} (AI provider)`, isSet: !!b.auth?.configured, page: 'ai-providers', pageLabel: 'AI providers' })
        }
      } catch (err) {
        console.warn('[SecretsSection] Could not read the AI providers:', err)
      }
      try {
        const connectors = (await window.electronAPI?.connectors?.list?.()) ?? []
        for (const c of connectors) {
          for (const f of c.fields.filter((field) => field.secret)) {
            rows.push({ label: `${c.label}: ${f.label}`, isSet: !!f.hasValue, page: 'connectors', pageLabel: 'Connectors' })
          }
        }
      } catch (err) {
        console.warn('[SecretsSection] Could not read the connectors:', err)
      }
      if (live) setOthers(rows)
    }
    void load()
    return () => {
      live = false
    }
  }, [])

  if (!config) return null
  return (
    <div className="space-y-4" data-testid="settings-secrets">
      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Keys and tokens</h3>
        <p className="text-xs text-muted-foreground">
          Stored encrypted on this computer. HiDock never shows a saved value; replace it to change it.
        </p>
        {CONFIG_SECRETS.map((secret) => (
          <ConfigSecretRow key={secret.key} secret={secret} isSet={isSavedSecret(config[secret.section]?.[secret.key])} />
        ))}
      </section>
      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Kept by AI providers and connectors</h3>
        <p className="text-xs text-muted-foreground">Each is changed on its own page.</p>
        {others === null ? (
          <p className="py-3 text-xs text-muted-foreground">Reading…</p>
        ) : others.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">None stored.</p>
        ) : (
          others.map((o, i) => (
            <div key={`${o.page}-${i}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 last:border-b-0">
              <span className="text-sm">{o.label}</span>
              <div className="flex items-center gap-2">
                <span className={`text-xs ${o.isSet ? 'text-emerald-600' : 'text-muted-foreground'}`}>{o.isSet ? 'Set' : 'Not set'}</span>
                <Button size="sm" variant="ghost" onClick={() => onNavigate?.(o.page)}>
                  Open {o.pageLabel}
                </Button>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  )
}
