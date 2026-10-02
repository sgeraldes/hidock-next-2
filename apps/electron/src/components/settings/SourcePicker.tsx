import { useId, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { SourceContainer } from '@hidock/connectors'
import { Input } from '@/components/ui/input'
import { BusyIcon } from '@/components/ui/working'

/**
 * Type-to-filter picker for connectors with many sources (a Slack workspace
 * lists hundreds of channels). The chosen ones show as chips above the search;
 * the list below filters as you type and keeps the chosen ones first.
 */
export function SourcePicker({
  containers,
  isEnabled,
  onToggle,
  onToggleMany,
  noun = 'channel',
}: {
  containers: SourceContainer[]
  isEnabled: (c: SourceContainer) => boolean
  onToggle: (containerId: string, enabled: boolean) => void
  /** Choose or drop several at once (the filtered list); saved one after another. */
  onToggleMany?: (containerIds: string[], enabled: boolean) => Promise<void>
  noun?: string
}) {
  const [query, setQuery] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const listId = useId()

  const chosen = useMemo(() => containers.filter(isEnabled), [containers, isEnabled])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const member = (c: SourceContainer) => (c.metadata?.isMember ? 0 : 1)
    return containers
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.externalId.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(isEnabled(b)) - Number(isEnabled(a)) || member(a) - member(b) || a.name.localeCompare(b.name)
      )
  }, [containers, isEnabled, query])

  const filtered = query.trim().length > 0
  const shownOff = shown.filter((c) => !isEnabled(c))
  const shownOn = shown.filter((c) => isEnabled(c))
  const bulk = async (ids: string[], enabled: boolean) => {
    if (!onToggleMany || ids.length === 0) return
    setBulkBusy(true)
    try {
      await onToggleMany(ids, enabled)
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" aria-label={`Chosen ${noun}s`}>
        {chosen.length === 0 ? (
          <p className="text-xs text-muted-foreground">No {noun}s chosen yet. Nothing syncs until you pick one.</p>
        ) : (
          chosen.map((c) => (
            <span
              key={c.externalId}
              className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-0.5 text-xs"
            >
              #{c.name}
              <button
                type="button"
                onClick={() => onToggle(c.externalId, false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Stop syncing ${c.name}`}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))
        )}
      </div>
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Type to filter ${containers.length} ${noun}s`}
        aria-label={`Filter ${noun}s`}
        aria-controls={listId}
        autoComplete="off"
      />
      {onToggleMany && filtered && shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            className="font-medium text-primary hover:underline disabled:opacity-50 disabled:no-underline"
            disabled={bulkBusy || shownOff.length === 0}
            onClick={() => void bulk(shownOff.map((c) => c.externalId), true)}
            aria-busy={bulkBusy || undefined}
            title={bulkBusy ? 'Saving' : undefined}
          >
            {bulkBusy && <BusyIcon className="mr-1 inline h-3 w-3" />}
            {`Choose all ${shown.length} shown`}
          </button>
          {shownOn.length > 0 && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
              disabled={bulkBusy}
              onClick={() => void bulk(shownOn.map((c) => c.externalId), false)}
            >
              Drop the {shownOn.length} chosen here
            </button>
          )}
        </div>
      )}
      {/* Real checkboxes: Tab reaches each one and Space toggles it (review of #53, A1). */}
      <fieldset id={listId} className="max-h-72 overflow-y-auto rounded border border-border">
        <legend className="sr-only">{`${noun[0].toUpperCase()}${noun.slice(1)}s to sync`}</legend>
        {shown.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No {noun} matches &ldquo;{query}&rdquo;.</p>}
        {shown.map((c) => {
          const on = isEnabled(c)
          return (
            <label
              key={c.externalId}
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted/50 focus-within:bg-muted/50"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => onToggle(c.externalId, e.target.checked)}
                className="h-4 w-4 shrink-0 accent-primary"
              />
              <span className="min-w-0 flex-1 truncate">#{c.name}</span>
              {c.kind !== 'channel' && <span className="text-xs text-muted-foreground">{c.kind.replace('_', ' ')}</span>}
              {!c.metadata?.isMember && <span className="text-xs text-muted-foreground">not a member</span>}
            </label>
          )
        })}
      </fieldset>
    </div>
  )
}
