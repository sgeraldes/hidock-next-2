/**
 * Settings > Library (settings spec, phase 5): how the list shows and sorts,
 * and how each reader section opens. The same store the Library header
 * changes, so the two always agree (one key, two controls).
 */
import { useLibraryStore, type ReaderSectionId, type ReaderSectionMode, type SortBy, type SortOrder } from '@/store/useLibraryStore'

const SORTS: Array<{ value: SortBy; label: string }> = [
  { value: 'date', label: 'Date' },
  { value: 'duration', label: 'Length' },
  { value: 'name', label: 'Title' },
  { value: 'quality', label: 'Rating' }
]

const SECTIONS: Array<{ id: ReaderSectionId; label: string }> = [
  { id: 'player', label: 'Player' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'moments', label: 'Actions & decisions' },
  { id: 'summary', label: 'Summary' },
  { id: 'transcript', label: 'Full transcript' }
]

const MODES: Array<{ value: ReaderSectionMode; label: string }> = [
  { value: 'expanded', label: 'Open' },
  { value: 'compact', label: 'Compact' },
  { value: 'docked', label: 'Pinned to the top' },
  { value: 'hidden', label: 'Hidden' }
]

const selectClass = 'rounded-md border border-input bg-background px-2 py-1 text-sm'

export function LibrarySection() {
  const viewMode = useLibraryStore((s) => s.viewMode)
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const sortBy = useLibraryStore((s) => s.sortBy)
  const setSortBy = useLibraryStore((s) => s.setSortBy)
  const sortOrder = useLibraryStore((s) => s.sortOrder)
  const setSortOrder = useLibraryStore((s) => s.setSortOrder)
  const modes = useLibraryStore((s) => s.readerSectionModes)
  const setMode = useLibraryStore((s) => s.setReaderSectionMode)

  return (
    <div className="space-y-4" data-testid="settings-library">
      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">The list</h3>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="libraryRows" className="text-sm">
            Rows
          </label>
          <select id="libraryRows" className={selectClass} value={viewMode} onChange={(e) => setViewMode(e.target.value as 'compact' | 'card')}>
            <option value="compact">One line each</option>
            <option value="card">Cards</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="librarySort" className="text-sm">
            Sort by
          </label>
          <div className="flex gap-2">
            <select id="librarySort" className={selectClass} value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort order"
              className={selectClass}
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">The Library header changes the same values.</p>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">When you open a source</h3>
        {SECTIONS.map((section) => (
          <div key={section.id} className="flex flex-wrap items-center justify-between gap-3">
            <label htmlFor={`readerMode-${section.id}`} className="text-sm">
              {section.label}
            </label>
            <select
              id={`readerMode-${section.id}`}
              className={selectClass}
              value={modes[section.id]}
              onChange={(e) => setMode(section.id, e.target.value as ReaderSectionMode)}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </section>
    </div>
  )
}
