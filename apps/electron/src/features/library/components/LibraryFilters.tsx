import {
  Filter,
  Cloud,
  HardDrive,
  Check,
  Search,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  LayoutGrid,
  AudioLines,
  Image,
  FileText,
  StickyNote,
  Clock,
  X,
  Shapes
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import type { ExclusiveLocationFilter } from '@/types/unified-recording'
import type { SortBy, SortOrder } from '@/store/useLibraryStore'
import type {
  LibraryArtifactTypeDescriptor,
  SourceTypeFilter
} from '@/features/library/utils/sourceType'
import { DURATION_PRESET_LABELS, type DurationPreset } from '@/features/library/utils/durationFilter'
import { ISSUE_ORDER, ISSUE_TAGS, VALIDITY_FILTER_ORDER, integrityFilterLabel, isIntegrityFilter } from '@/features/library/utils/transcriptIntegrity'
import { VALIDITY_LABELS } from '@/features/library/utils/transcriptValidity'
import { AUDIO_FILTERS, isAudioFilter } from '@/features/library/utils/audioCheck'
import { CONTEXT_FILTERS, KIND_FILTERS, STARS_FILTERS, WARNING_FILTERS } from '@/features/library/utils/evaluation'

export type TypeCounts = Record<string, number> & { all: number }

interface LibraryFiltersProps {
  stats: {
    total: number
    deviceOnly: number
    localOnly: number
    both: number
  }
  filterableCount: number
  typeCounts: TypeCounts
  artifactTypes: LibraryArtifactTypeDescriptor[]
  hasRatedQuality: boolean
  exclusiveFilter: ExclusiveLocationFilter
  qualityFilter: string
  statusFilter: string
  sourceTypeFilter: SourceTypeFilter
  durationPreset: DurationPreset
  searchQuery: string
  sortBy?: SortBy
  sortOrder?: SortOrder
  onExclusiveFilterChange: (filter: ExclusiveLocationFilter) => void
  onCategoryFilterChange: (filter: string) => void
  onQualityFilterChange: (filter: string) => void
  onStatusFilterChange: (filter: string) => void
  onSourceTypeFilterChange: (filter: SourceTypeFilter) => void
  onDurationPresetChange: (preset: DurationPreset) => void
  onSearchQueryChange: (query: string) => void
  onSortByChange?: (sortBy: SortBy) => void
  onSortOrderChange?: (order: SortOrder) => void
  onClearFilters: () => void
  /** Transcript integrity filter ('all' when off) and how many transcripts each value matches. */
  integrityFilter?: string
  integrityCounts?: Record<string, number>
  onIntegrityFilterChange?: (filter: string) => void
  /** Audio check filter ('all' when off) and how many recordings each value matches. */
  audioFilter?: string
  audioCounts?: Record<string, number>
  onAudioFilterChange?: (filter: string) => void
  /** Jev evaluation filters ('all' when off), with how many recordings each value matches. */
  evaluation?: EvaluationFilterProps
}

type EvaluationKey = 'kind' | 'context' | 'stars' | 'warning'

export interface EvaluationFilterProps {
  kind: string
  context: string
  stars: string
  warning: string
  counts: Record<EvaluationKey, Record<string, number>>
  onChange: (key: EvaluationKey, value: string) => void
}

const EVALUATION_SECTIONS: { key: EvaluationKey; title: string; any: string; options: { value: string; label: string }[] }[] = [
  { key: 'kind', title: 'Kind', any: 'Any kind', options: KIND_FILTERS },
  { key: 'context', title: 'Work or personal', any: 'Any', options: CONTEXT_FILTERS },
  { key: 'stars', title: 'Stars', any: 'Any stars', options: STARS_FILTERS },
  { key: 'warning', title: 'Transcript warnings', any: 'Any', options: WARNING_FILTERS }
]

const DURATION_PRESETS: DurationPreset[] = ['all', 'under10s', 'under1m', 'under5m', 'over5m']

function iconForType(type: string): LucideIcon {
  if (type === 'audio') return AudioLines
  if (type === 'image') return Image
  if (type === 'pdf') return FileText
  if (type === 'note') return StickyNote
  return Shapes
}

export function LibraryFilters({
  stats,
  filterableCount,
  typeCounts,
  artifactTypes,
  hasRatedQuality,
  exclusiveFilter,
  qualityFilter,
  statusFilter,
  sourceTypeFilter,
  durationPreset,
  searchQuery,
  sortBy,
  sortOrder,
  onExclusiveFilterChange,
  onCategoryFilterChange,
  onQualityFilterChange,
  onStatusFilterChange,
  onSourceTypeFilterChange,
  onDurationPresetChange,
  onSearchQueryChange,
  onSortByChange,
  onSortOrderChange,
  onClearFilters,
  integrityFilter = 'all',
  integrityCounts = {},
  onIntegrityFilterChange,
  audioFilter = 'all',
  audioCounts = {},
  onAudioFilterChange,
  evaluation
}: LibraryFiltersProps) {
  const selectedType = artifactTypes.find((type) => type.id === sourceTypeFilter)
  const supportsDuration = selectedType?.capabilities.includes('timed') ?? false
  const supportsQuality = hasRatedQuality && (sourceTypeFilter === 'all' || selectedType?.capabilities.includes('rateable'))

  const populatedTypes = artifactTypes.filter((type) => (typeCounts[type.id] ?? 0) > 0 || type.id === sourceTypeFilter)
  const primaryTypes = populatedTypes.slice(0, 4)
  const overflowTypes = populatedTypes.slice(4)
  const exactStates = [stats.deviceOnly, stats.localOnly, stats.both].filter((count) => count > 0).length
  const showAvailability = exactStates > 1 || exclusiveFilter !== 'all'

  const advancedActiveCount = [
    exclusiveFilter !== 'all',
    supportsQuality && qualityFilter !== 'all',
    statusFilter !== 'all',
    supportsDuration && durationPreset !== 'all',
    integrityFilter !== 'all',
    audioFilter !== 'all',
    ...EVALUATION_SECTIONS.map((section) => !!evaluation && evaluation[section.key] !== 'all')
  ].filter(Boolean).length
  const anyFilterActive = advancedActiveCount > 0 || sourceTypeFilter !== 'all' || searchQuery.length > 0

  const selectType = (type: SourceTypeFilter) => {
    const next = artifactTypes.find((item) => item.id === type)
    if (!next?.capabilities.includes('timed')) {
      onDurationPresetChange('all')
      if (sortBy === 'duration') onSortByChange?.('date')
    }
    if (!next?.capabilities.includes('conversation')) onCategoryFilterChange('all')
    if (type !== 'audio' && exclusiveFilter === 'source-only') onExclusiveFilterChange('all')
    onSourceTypeFilterChange(type)
  }

  const chips: Array<{ key: string; label: string; clear: () => void }> = []
  // "On device only" is represented by the pressed status control in the
  // Library header. Repeating it here created a second, orphaned control row.
  if (exclusiveFilter !== 'all' && exclusiveFilter !== 'source-only') {
    chips.push({
      key: 'availability',
      label: exclusiveFilter === 'local-only' ? 'Local only' : 'Synced',
      clear: () => onExclusiveFilterChange('all')
    })
  }
  if (supportsDuration && durationPreset !== 'all') {
    chips.push({ key: 'duration', label: DURATION_PRESET_LABELS[durationPreset], clear: () => onDurationPresetChange('all') })
  }
  if (supportsQuality && qualityFilter !== 'all') {
    chips.push({ key: 'quality', label: qualityFilter, clear: () => onQualityFilterChange('all') })
  }
  if (statusFilter !== 'all') {
    chips.push({ key: 'status', label: statusFilter, clear: () => onStatusFilterChange('all') })
  }
  if (integrityFilter !== 'all' && onIntegrityFilterChange && isIntegrityFilter(integrityFilter)) {
    chips.push({ key: 'integrity', label: integrityFilterLabel(integrityFilter), clear: () => onIntegrityFilterChange('all') })
  }
  if (audioFilter !== 'all' && onAudioFilterChange && isAudioFilter(audioFilter)) {
    const label = AUDIO_FILTERS.find((f) => f.value === audioFilter)?.label ?? audioFilter
    chips.push({ key: 'audio', label: `Audio: ${label}`, clear: () => onAudioFilterChange('all') })
  }
  if (evaluation) {
    for (const section of EVALUATION_SECTIONS) {
      const value = evaluation[section.key]
      if (value === 'all') continue
      const label = section.options.find((o) => o.value === value)?.label ?? value
      chips.push({ key: `eval-${section.key}`, label: `${section.title}: ${label}`, clear: () => evaluation.onChange(section.key, 'all') })
    }
  }
  const showAudio = !!onAudioFilterChange
  const heldCount = VALIDITY_FILTER_ORDER.reduce((sum, status) => sum + (integrityCounts[`validity:${status}`] ?? 0), 0)
  const showIntegrity =
    !!onIntegrityFilterChange &&
    ((integrityCounts.flagged ?? 0) > 0 || (integrityCounts.accepted ?? 0) > 0 || heldCount > 0 || integrityFilter !== 'all')

  return (
    <div className="space-y-2 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex max-w-full shrink-0 overflow-x-auto rounded-lg border" role="group" aria-label="Filter by artifact type" data-testid="source-type-filter">
          <TypeButton type="all" label="All" count={typeCounts.all} Icon={LayoutGrid} active={sourceTypeFilter === 'all'} onClick={() => selectType('all')} />
          {primaryTypes.map((type) => (
            <TypeButton
              key={type.id}
              type={type.id}
              label={type.pluralLabel}
              count={typeCounts[type.id] ?? 0}
              Icon={iconForType(type.id)}
              active={sourceTypeFilter === type.id}
              onClick={() => selectType(type.id)}
            />
          ))}
          {overflowTypes.length > 0 && (
            <select
              value={overflowTypes.some((type) => type.id === sourceTypeFilter) ? sourceTypeFilter : ''}
              onChange={(event) => event.target.value && selectType(event.target.value)}
              className="border-l bg-background px-2 text-xs font-medium"
              aria-label="More artifact types"
            >
              <option value="">More types</option>
              {overflowTypes.map((type) => <option key={type.id} value={type.id}>{type.pluralLabel} ({typeCounts[type.id] ?? 0})</option>)}
            </select>
          )}
        </div>

        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder={`Search ${filterableCount} source${filterableCount === 1 ? '' : 's'}…`}
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            className="pl-9 pr-8 h-8"
            aria-label="Search the sources shown in this list"
          />
          {searchQuery && (
            <button onClick={() => onSearchQueryChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" aria-label="Clear list filter">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center gap-1.5 h-8 rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-muted transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" aria-label="More filters and sorting">
              <Filter className="h-3.5 w-3.5" aria-hidden="true" />
              Filters
              {advancedActiveCount > 0 && <span className="ml-0.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold tabular-nums">{advancedActiveCount}</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="flex items-center justify-between px-4 py-2.5 border-b">
              <span className="text-sm font-semibold">Filters &amp; sort</span>
              {anyFilterActive && <button onClick={onClearFilters} className="text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:underline">Clear all</button>}
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-4 space-y-4">
              {onSortByChange && onSortOrderChange && (
                <section className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground/70"><ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" /> Sort</div>
                  <div className="flex items-center gap-2">
                    <select value={sortBy ?? 'date'} onChange={(event) => onSortByChange(event.target.value as SortBy)} className="h-8 flex-1 rounded-md border border-input bg-background px-3 py-1 text-xs" aria-label="Sort by">
                      <option value="date">Date</option>
                      <option value="name">Title</option>
                      {supportsDuration && <option value="duration">Duration</option>}
                      {supportsQuality && <option value="quality">Quality</option>}
                      <option value="stars">Stars</option>
                      <option value="meeting">Calendar meeting</option>
                      <option value="status">File status</option>
                      <option value="transcription">Transcript</option>
                    </select>
                    <button onClick={() => onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')} className="h-8 px-2 rounded-md border border-input bg-background text-xs font-medium hover:bg-muted transition-colors inline-flex items-center gap-1" aria-label={`Sort ${sortOrder === 'asc' ? 'ascending' : 'descending'}`}>
                      {sortOrder === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {sortOrder === 'asc' ? 'Asc' : 'Desc'}
                    </button>
                  </div>
                </section>
              )}

              {showAvailability && (
                <section className="space-y-1.5">
                  <div className="text-xs font-semibold text-foreground/70">Availability</div>
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Availability filter" data-testid="location-filter">
                    <FacetButton active={exclusiveFilter === 'all'} onClick={() => onExclusiveFilterChange('all')} label={`All (${stats.total})`} />
                    {(stats.deviceOnly > 0 || exclusiveFilter === 'source-only') && <FacetButton Icon={Cloud} active={exclusiveFilter === 'source-only'} onClick={() => onExclusiveFilterChange('source-only')} label={`On device only (${stats.deviceOnly})`} />}
                    {(stats.localOnly > 0 || exclusiveFilter === 'local-only') && <FacetButton Icon={HardDrive} active={exclusiveFilter === 'local-only'} onClick={() => onExclusiveFilterChange('local-only')} label={`Local only (${stats.localOnly})`} />}
                    {(stats.both > 0 || exclusiveFilter === 'synced') && <FacetButton Icon={Check} active={exclusiveFilter === 'synced'} onClick={() => onExclusiveFilterChange('synced')} label={`Synced (${stats.both})`} />}
                  </div>
                </section>
              )}

              {supportsDuration && (
                <section className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground/70"><Clock className="h-3.5 w-3.5" aria-hidden="true" /> Duration</div>
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by duration">
                    {DURATION_PRESETS.map((preset) => <FacetButton key={preset} active={durationPreset === preset} onClick={() => onDurationPresetChange(preset)} label={DURATION_PRESET_LABELS[preset]} />)}
                  </div>
                </section>
              )}

              {supportsQuality && (
                <section className="space-y-1.5">
                  <div className="text-xs font-semibold text-foreground/70">Quality</div>
                  <select value={qualityFilter} onChange={(event) => onQualityFilterChange(event.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs" aria-label="Filter by quality rating">
                    <option value="all">All ratings</option><option value="valuable">Valuable</option><option value="archived">Archived</option><option value="low-value">Low-value</option><option value="garbage">Garbage</option><option value="unrated">Unrated</option>
                  </select>
                </section>
              )}

              {showAudio && (
                <section className="space-y-1.5">
                  <div className="text-xs font-semibold text-foreground/70">Audio</div>
                  <select value={audioFilter} onChange={(event) => onAudioFilterChange?.(event.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs" aria-label="Filter by audio check">
                    <option value="all">Any audio</option>
                    {AUDIO_FILTERS.filter((f) => (audioCounts[f.value] ?? 0) > 0 || audioFilter === f.value).map((f) => (
                      <option key={f.value} value={f.value}>{f.label} ({audioCounts[f.value] ?? 0})</option>
                    ))}
                  </select>
                </section>
              )}

              {evaluation &&
                EVALUATION_SECTIONS.map((section) => {
                  const counts = evaluation.counts[section.key] ?? {}
                  const value = evaluation[section.key]
                  const options = section.options.filter((o) => (counts[o.value] ?? 0) > 0 || value === o.value)
                  // Nothing evaluated yet (or nothing to pick): no empty select.
                  if (options.length === 0) return null
                  return (
                    <section key={section.key} className="space-y-1.5">
                      <div className="text-xs font-semibold text-foreground/70">{section.title}</div>
                      <select
                        value={value}
                        onChange={(event) => evaluation.onChange(section.key, event.target.value)}
                        className="h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs"
                        aria-label={`Filter by ${section.title.toLowerCase()}`}
                      >
                        <option value="all">{section.any}</option>
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>{o.label} ({counts[o.value] ?? 0})</option>
                        ))}
                      </select>
                    </section>
                  )
                })}

              {showIntegrity && (
                <section className="space-y-1.5">
                  <div className="text-xs font-semibold text-foreground/70">Transcript</div>
                  <select value={integrityFilter} onChange={(event) => onIntegrityFilterChange?.(event.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs" aria-label="Filter by transcript problems">
                    <option value="all">Any transcript</option>
                    <option value="flagged">Transcription problems ({integrityCounts.flagged ?? 0})</option>
                    {VALIDITY_FILTER_ORDER.filter((status) => (integrityCounts[`validity:${status}`] ?? 0) > 0 || integrityFilter === `validity:${status}`).map((status) => (
                      <option key={status} value={`validity:${status}`}>{status === 'doubtful' ? 'Doubtful transcripts' : VALIDITY_LABELS[status].chip} ({integrityCounts[`validity:${status}`] ?? 0})</option>
                    ))}
                    {ISSUE_ORDER.filter((code) => (integrityCounts[`issue:${code}`] ?? 0) > 0 || integrityFilter === `issue:${code}`).map((code) => (
                      <option key={code} value={`issue:${code}`}>{ISSUE_TAGS[code]} ({integrityCounts[`issue:${code}`] ?? 0})</option>
                    ))}
                    {((integrityCounts.accepted ?? 0) > 0 || integrityFilter === 'accepted') && <option value="accepted">Accepted as is ({integrityCounts.accepted ?? 0})</option>}
                  </select>
                </section>
              )}

              <section className="space-y-1.5">
                <div className="text-xs font-semibold text-foreground/70">Processing</div>
                <select value={statusFilter} onChange={(event) => onStatusFilterChange(event.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs" aria-label="Filter by processing status">
                  <option value="all">Any state</option><option value="processing">Processing</option><option value="ready">Ready</option><option value="enriched">Enriched</option>
                </select>
              </section>

            </div>
          </PopoverContent>
        </Popover>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {chips.map((chip) => (
            <button key={chip.key} onClick={chip.clear} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-1 text-xs text-foreground hover:bg-muted" aria-label={`Remove ${chip.label} filter`}>
              {chip.label}<X className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
          {chips.length > 1 && <button onClick={onClearFilters} className="px-1 text-xs text-muted-foreground hover:text-foreground hover:underline">Clear all</button>}
        </div>
      )}
    </div>
  )
}

function TypeButton({ type, label, count, Icon, active, onClick }: { type: string; label: string; count: number; Icon: LucideIcon; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`shrink-0 px-2.5 py-1.5 text-xs font-medium transition-colors inline-flex items-center gap-1.5 ${type !== 'all' ? 'border-l' : ''} ${active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} aria-pressed={active} aria-label={`${label} (${count})`} title={`${label} — ${count}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden @md:inline sm:inline">{label}</span>
      <span className={`tabular-nums ${active ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{count}</span>
    </button>
  )
}

function FacetButton({ active, onClick, label, Icon }: { active: boolean; onClick: () => void; label: string; Icon?: LucideIcon }) {
  return (
    <button onClick={onClick} className={`px-2 py-1 text-xs font-medium rounded border transition-colors inline-flex items-center gap-1 ${active ? 'bg-primary text-primary-foreground border-primary' : 'border-input hover:bg-muted'}`} aria-pressed={active}>
      {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}{label}
    </button>
  )
}
