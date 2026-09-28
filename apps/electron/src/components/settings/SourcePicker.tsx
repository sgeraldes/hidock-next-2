import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { SourceContainer } from '@hidock/connectors'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'

/**
 * Type-to-filter picker for connectors with many sources (a Slack workspace
 * lists hundreds of channels). The chosen ones show as chips above the search;
 * the list below filters as you type and keeps the chosen ones first.
 */
export function SourcePicker({
  containers,
  isEnabled,
  onToggle,
  noun = 'channel',
}: {
  containers: SourceContainer[]
  isEnabled: (c: SourceContainer) => boolean
  onToggle: (containerId: string, enabled: boolean) => void
  noun?: string
}) {
  const [query, setQuery] = useState('')

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
        role="combobox"
        aria-expanded="true"
        aria-controls="source-picker-list"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Type to filter ${containers.length} ${noun}s`}
        autoComplete="off"
      />
      <ul
        id="source-picker-list"
        role="listbox"
        aria-multiselectable="true"
        className="max-h-72 overflow-y-auto rounded border border-border"
      >
        {shown.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No {noun} matches &ldquo;{query}&rdquo;.</li>}
        {shown.map((c) => {
          const on = isEnabled(c)
          return (
            <li
              key={c.externalId}
              role="option"
              aria-selected={on}
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted/50"
              onClick={() => onToggle(c.externalId, !on)}
            >
              <Checkbox checked={on} tabIndex={-1} aria-hidden="true" onClick={(e) => e.stopPropagation()} onCheckedChange={(v) => onToggle(c.externalId, v)} />
              <span className="min-w-0 flex-1 truncate">#{c.name}</span>
              {c.kind !== 'channel' && <span className="text-xs text-muted-foreground">{c.kind.replace('_', ' ')}</span>}
              {!c.metadata?.isMember && <span className="text-xs text-muted-foreground">not a member</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
