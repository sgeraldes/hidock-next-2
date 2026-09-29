/**
 * Settings > Speakers & voices: which contact is you (identity.ownerContactId).
 * A saved live stream names you on its microphone channel with it
 * (live-channel-speakers.ts, 28-sep-2026).
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { useConfigStore } from '@/store/domain/useConfigStore'

interface Found {
  id: string
  name: string
  email?: string | null
}

export function OwnerContactPicker() {
  const ownerId = useConfigStore((s) => s.config?.identity?.ownerContactId) ?? ''
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const [ownerName, setOwnerName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Found[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    if (!ownerId) {
      setOwnerName(null)
      return
    }
    window.electronAPI?.contacts
      ?.getById(ownerId)
      .then((r) => live && setOwnerName(r.success ? r.data.contact.name : null))
      .catch(() => live && setOwnerName(null))
    return () => {
      live = false
    }
  }, [ownerId])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setFound([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      window.electronAPI?.contacts
        ?.getAll({ search: q, limit: 8 })
        .then((r) => live && setFound(r.success ? r.data.contacts.map((c) => ({ id: c.id, name: c.name, email: (c as { email?: string | null }).email })) : []))
        .catch(() => live && setFound([]))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  const choose = async (id: string) => {
    setBusy(true)
    try {
      await updateConfig('identity', { ownerContactId: id } as never)
      setQuery('')
      setFound([])
    } catch (err) {
      toast.error('Could not save who you are', err instanceof Error ? err.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid="owner-contact">
      <div>
        <h3 className="text-sm font-semibold">This is you</h3>
        <p className="text-xs text-muted-foreground">
          In a live stream saved from the HiDock, the speaker on the microphone is named after this contact.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">{ownerId ? (ownerName ?? 'A contact that no longer exists') : 'Not chosen yet'}</span>
        {ownerId && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void choose('')}>
            Clear
          </Button>
        )}
      </div>
      <label htmlFor="ownerSearch" className="sr-only">
        Find yourself among the contacts
      </label>
      <Input
        id="ownerSearch"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type your name or email"
        className="h-8 text-sm"
        autoComplete="off"
      />
      {found.length > 0 && (
        <ul className="rounded border border-border" aria-label="Matching contacts">
          {found.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void choose(c.id)}
                className="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-left text-sm last:border-b-0 hover:bg-muted/50"
              >
                <span>{c.name}</span>
                {c.email && <span className="text-xs text-muted-foreground">{c.email}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
