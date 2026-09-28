import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  SETTINGS_GROUP_LABELS,
  SETTINGS_SECTIONS,
  searchSettingsSections,
  type SettingsGroupId,
  type SettingsSectionId
} from './sections'

const GROUP_ORDER: SettingsGroupId[] = ['general', 'preferences', 'services', 'system']

/**
 * The Settings menu: a search box, then the sections by group. On a narrow
 * window it becomes a single list picker above the page.
 */
export function SettingsNav({
  active,
  onSelect
}: {
  active: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
}) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => new Set(searchSettingsSections(query).map((s) => s.id)), [query])
  const visible = SETTINGS_SECTIONS.filter((s) => matches.has(s.id))

  return (
    <>
      {/* Narrow windows: one picker instead of the side menu. */}
      <div className="border-b border-border p-3 md:hidden">
        <label htmlFor="settings-section-picker" className="sr-only">
          Settings section
        </label>
        <select
          id="settings-section-picker"
          value={active}
          onChange={(e) => onSelect(e.target.value as SettingsSectionId)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {SETTINGS_SECTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <nav
        aria-label="Settings sections"
        className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border px-3 py-4 md:flex"
      >
        <h1 className="px-2 text-xl font-semibold">Settings</h1>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && visible[0]) onSelect(visible[0].id)
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-8 pl-8 text-sm"
          />
        </div>
        {visible.length === 0 && <p className="px-2 text-xs text-muted-foreground">Nothing matches &ldquo;{query}&rdquo;.</p>}
        {GROUP_ORDER.map((group) => {
          const items = visible.filter((s) => s.group === group)
          if (items.length === 0) return null
          const label = SETTINGS_GROUP_LABELS[group]
          return (
            <div key={group} className="space-y-0.5">
              {label && <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>}
              {items.map((s) => {
                const Icon = s.icon
                const isActive = s.id === active
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelect(s.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      isActive ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80 hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{s.label}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </nav>
    </>
  )
}
