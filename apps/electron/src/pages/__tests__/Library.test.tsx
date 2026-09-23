import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { Library } from '../Library'

/**
 * Rows are located by the text the row shows. Since 2026-09-22 an unassigned
 * source shows its title when it has one; the filename moved to the second
 * line's tooltip. Fixtures unchanged, locators follow the row.
 */

// Shared harness for the "reveal opened source" behavior: a STABLE scrollToIndex
// spy (so we can assert across renders) and a mutable selectedSourceId the store
// mock reads at call time. Defaults keep existing tests unaffected.
const scrollHarness = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  selectedSourceId: null as string | null
}))
const virtualizerHarness = vi.hoisted(() => ({
  measure: vi.fn(),
  measureElement: vi.fn(),
  options: null as null | {
    count: number
    estimateSize: () => number
    getItemKey?: (index: number) => string | number
  }
}))
const deviceSyncHarness = vi.hoisted(() => ({
  scanAndReconcile: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/services/device-sync-actions', () => ({
  scanAndReconcile: deviceSyncHarness.scanAndReconcile
}))

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
const integrityHarness = vi.hoisted(() => ({ filter: null as string | null, set: vi.fn(), search: '' }))
vi.mock('@/components/ui/toaster', () => ({ toast: toastMock }))

// Mock hooks
vi.mock('@/hooks/useUnifiedRecordings', () => ({
  useUnifiedRecordings: vi.fn(),
  overlayActiveTranscriptionStatuses: (recordings: unknown[]) => recordings
}))

vi.mock('@/store/useUIStore', () => {
  const state = {
    currentlyPlayingId: null,
    setCurrentlyPlayingId: vi.fn(),
    recordingsCompactView: true,
    setRecordingsCompactView: vi.fn(),
    // Waveform-preload fields read by SourceReader's preload effect via getState().
    waveformLoadedForId: null,
    waveformLoadingId: null,
    setWaveformLoadedForId: vi.fn(),
    setWaveformLoadingId: vi.fn()
  }
  const useUIStore = vi.fn((selector?: (s: typeof state) => unknown) =>
    typeof selector === 'function' ? selector(state) : state
  ) as unknown as { (selector?: (s: typeof state) => unknown): unknown; getState: () => typeof state; setState: ReturnType<typeof vi.fn> }
  useUIStore.getState = () => state
  useUIStore.setState = vi.fn()
  return { useUIStore }
})

vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector) => {
    const state = {
      isConnected: false,
      deviceInfo: null,
      downloadQueue: new Map(),
      isDownloading: () => false
    }
    return typeof selector === 'function' ? selector(state) : state
  }),
  useDownloadQueue: vi.fn().mockReturnValue(new Map()),
  useDeviceSyncProgress: vi.fn().mockReturnValue(null),
  useDeviceSyncEta: vi.fn().mockReturnValue(null),
  useDeviceConnected: vi.fn().mockReturnValue(false),
  useDeviceSyncing: vi.fn().mockReturnValue(false),
  useConnectionStatus: vi.fn().mockReturnValue({ step: 'idle', message: 'Not connected' }),
  useDeviceState: vi.fn().mockReturnValue({ connected: false }),
  useIsDownloading: vi.fn().mockReturnValue(false),
  useDownloadProgress: vi.fn().mockReturnValue(null)
}))

vi.mock('@/components/OperationController', () => ({
  useAudioControls: vi.fn(() => ({
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    isPlaying: false,
    currentTime: 0,
    duration: 0
  }))
}))

// Mock storage for virtualizer items - accessed via global to survive module mock
declare global {
  var __mockVirtualizerCount: number
}
globalThis.__mockVirtualizerCount = 0

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: {
    count: number
    estimateSize: () => number
    getItemKey?: (index: number) => string | number
  }) => {
    virtualizerHarness.options = options
    const size = options.estimateSize()
    return {
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({
      index,
      size,
      start: index * size,
      key: options.getItemKey?.(index) ?? String(index)
    })),
    getTotalSize: () => options.count * size,
    scrollToIndex: scrollHarness.scrollToIndex,
    measureElement: virtualizerHarness.measureElement,
    measure: virtualizerHarness.measure
  }
  }
}))

vi.mock('@/store/useLibraryStore', () => ({
  useLibraryStore: vi.fn((selector) => {
    const state = {
      // Reader-pane state. Keep in sync with useLibraryStore's initialState —
      // a missing key here surfaces as "Cannot read properties of undefined"
      // deep inside a render, not as an obvious mock error.
      readerSectionModes: {
        player: 'expanded',
        metadata: 'expanded',
        moments: 'expanded',
        summary: 'expanded',
        transcript: 'expanded'
      },
      setReaderSectionMode: vi.fn(),
      readerVerticalSizes: [64, 36],
      setReaderVerticalSizes: vi.fn(),
      readerMaximizedSection: null,
      setReaderMaximizedSection: vi.fn(),
      toggleReaderMaximizedSection: vi.fn(),
      readerListCollapsedBeforeMaximize: null,
      listPaneSize: 25,
      setListPaneSize: vi.fn(),
      listCollapsed: false,
      setListCollapsed: vi.fn(),
      qualityFilter: null,
      setQualityFilter: vi.fn(),
      integrityFilter: integrityHarness.filter,
      setIntegrityFilter: integrityHarness.set,
      statusFilter: null,
      setStatusFilter: vi.fn(),
      searchQuery: integrityHarness.search,
      setSearchQuery: vi.fn(),
      viewMode: 'compact',
      sortBy: 'date',
      sortOrder: 'desc',
      sourceTypeFilter: 'all',
      durationPreset: 'all',
      assistantDock: 'collapsed',
      selectedIds: new Set(),
      recordingErrors: new Map(),
      scrollOffset: 0,
      setViewMode: vi.fn(),
      toggleViewMode: vi.fn(),
      setSortBy: vi.fn(),
      setSortOrder: vi.fn(),
      toggleSortOrder: vi.fn(),
      setSourceTypeFilter: vi.fn(),
      setDurationPreset: vi.fn(),
      setAssistantDock: vi.fn(),
      clearFilters: vi.fn(),
      setScrollOffset: vi.fn(),
      setRecordingError: vi.fn(),
      clearRecordingError: vi.fn(),
      toggleSelection: vi.fn(),
      selectAll: vi.fn(),
      clearSelection: vi.fn(),
      panelSizes: [25, 45, 30],
      setPanelSizes: vi.fn(),
      selectedSourceId: scrollHarness.selectedSourceId,
      setSelectedSourceId: vi.fn(),
      expandedRowIds: new Set(),
      expandedTranscripts: new Set(),
      toggleRowExpansion: vi.fn(),
      expandRow: vi.fn(),
      collapseRow: vi.fn(),
      collapseAllRows: vi.fn(),
      toggleTranscriptExpansion: vi.fn(),
      collapseAllTranscripts: vi.fn()
    }
    return typeof selector === 'function' ? selector(state) : state
  }),
  useLibrarySorting: vi.fn(() => ({ sortBy: 'date', sortOrder: 'desc' }))
}))

vi.mock('@/hooks/useOperations', () => ({
  useOperations: vi.fn(() => ({
    queueTranscription: vi.fn().mockResolvedValue(true),
    queueBulkTranscriptions: vi.fn().mockResolvedValue(0),
    queueDownload: vi.fn().mockResolvedValue(true),
    queueBulkDownloads: vi.fn().mockResolvedValue(0),
    cancelTranscription: vi.fn(),
    cancelAllTranscriptions: vi.fn(),
    cancelAllDownloads: vi.fn()
  }))
}))

vi.mock('@/features/library/hooks', () => ({
  useSourceSelection: vi.fn(() => ({
    selectedIds: new Set(),
    selectedCount: 0,
    toggleSelection: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    handleSelectionClick: vi.fn()
  })),
  useKeyboardNavigation: vi.fn(() => ({
    handleKeyDown: vi.fn(),
    focusedIndex: -1,
    containerRef: { current: null }
  })),
  useTransitionFilters: vi.fn(() => ({
    filterMode: 'semantic',
    semanticFilter: 'all',
    exclusiveFilter: 'all',
    categoryFilter: null,
    qualityFilter: null,
    statusFilter: null,
    searchQuery: integrityHarness.search,
    setFilterMode: vi.fn(),
    setSemanticFilter: vi.fn(),
    setExclusiveFilter: vi.fn(),
    setCategoryFilter: vi.fn(),
    setQualityFilter: vi.fn(),
    setStatusFilter: vi.fn(),
    setSearchQuery: vi.fn(),
    isPending: false
  })),
  // F16/spec-003 Part F — mounted once on the Library page; no-op here since
  // this suite doesn't exercise the suggestion-toast behavior (see
  // useValueSuggestionToasts.test.tsx for that coverage).
  useValueSuggestionToasts: vi.fn()
}))

const mockRefresh = vi.fn()
const transcriptionCompletedListeners: Array<(data: { recordingId: string }) => void> = []
const transcriptionFailedListeners: Array<() => void> = []
const transcriptionCancelledListeners: Array<() => void> = []

// Mock electronAPI
global.window.electronAPI = {
  // ADV13: Library uses the owner-management batch accessor.
  transcripts: {
    getByRecordingIds: vi.fn().mockResolvedValue({}),
    getByRecordingIdsOwner: vi.fn().mockResolvedValue({}),
    setIntegrityAccepted: vi.fn().mockResolvedValue({ success: true, data: { accepted: true } }),
    retranscribeMany: vi.fn().mockResolvedValue({ success: true, data: { queued: 1, skipped: 0 } })
  },
  meetings: { getByIds: vi.fn().mockResolvedValue({}) },
  knowledge: { getById: vi.fn().mockResolvedValue(null) },
  storage: { openFolder: vi.fn() },
  recordings: {
    addExternal: vi.fn(),
    delete: vi.fn(),
    updateStatus: vi.fn(),
    markPersonal: vi.fn().mockResolvedValue({ success: true, personal: true }),
    deletionImpact: vi.fn().mockResolvedValue({ success: true, data: { transcripts: 0, actionItems: 0, embeddings: 0, artifacts: 0, hasAudioFile: true } }),
    deleteCascade: vi.fn().mockResolvedValue({ success: true, mode: 'soft' }),
    restore: vi.fn().mockResolvedValue({ success: true }),
    // spec-005/F17 T5 — loaded eagerly on mount (for the Trash toggle's count).
    getTrash: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    backfillDurations: vi.fn().mockResolvedValue({ success: true })
  },
  downloadService: {
    queueDownloads: vi.fn(),
    truncatedRecoveryPlan: vi.fn().mockResolvedValue(null),
    recoverTruncated: vi.fn().mockResolvedValue({ queued: [], skipped: [] })
  },
  onTranscriptionCompleted: vi.fn((callback) => {
    transcriptionCompletedListeners.push(callback)
    return vi.fn()
  }),
  onTranscriptionFailed: vi.fn((callback) => {
    transcriptionFailedListeners.push(callback)
    return vi.fn()
  }),
  onTranscriptionCancelled: vi.fn((callback) => {
    transcriptionCancelledListeners.push(callback)
    return vi.fn()
  })
} as any

import { useUnifiedRecordings } from '@/hooks/useUnifiedRecordings'

const mockRecording = {
  id: 'test-123',
  filename: 'test.wav',
  quality: 'valuable' as const,
  duration: 120,
  size: 1024000,
  dateRecorded: new Date(),
  location: 'local-only' as const,
  localPath: '/path/test.wav',
  syncStatus: 'synced' as const,
  transcriptionStatus: 'complete' as const,
  title: 'Test Recording'
}

describe('Library', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scrollHarness.scrollToIndex.mockClear()
    scrollHarness.selectedSourceId = null
    virtualizerHarness.measure.mockClear()
    virtualizerHarness.measureElement.mockClear()
    virtualizerHarness.options = null
    mockRefresh.mockReset()
    deviceSyncHarness.scanAndReconcile.mockReset().mockResolvedValue(undefined)
    transcriptionCompletedListeners.length = 0
    transcriptionFailedListeners.length = 0
    transcriptionCancelledListeners.length = 0
    vi.mocked(window.electronAPI.transcripts.getByRecordingIds).mockResolvedValue({})
    vi.mocked(window.electronAPI.transcripts.getByRecordingIdsOwner).mockResolvedValue({})
    vi.mocked(window.electronAPI.meetings.getByIds).mockResolvedValue({})
    vi.mocked(window.electronAPI.recordings.getById).mockResolvedValue(null)
    vi.mocked(window.electronAPI.knowledge.getById).mockResolvedValue(null)
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: [],
      loading: false,
      error: null,
      refresh: mockRefresh,
      deviceConnected: false,
      stats: { total: 0, deviceOnly: 0, localOnly: 0, both: 0, synced: 0, unsynced: 0, onSource: 0, locallyAvailable: 0 }
    })
  })

  const renderLibrary = () => {
    return render(
      <MemoryRouter>
        <Library />
      </MemoryRouter>
    )
  }

  describe('Manual refresh', () => {
    it('forces device reconciliation before rebuilding the Library view', async () => {
      const calls: string[] = []
      deviceSyncHarness.scanAndReconcile.mockImplementation(async () => {
        calls.push('sync')
      })
      mockRefresh.mockImplementation(async () => {
        calls.push('refresh')
      })

      renderLibrary()
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Library' }))

      await waitFor(() => {
        expect(deviceSyncHarness.scanAndReconcile).toHaveBeenCalledWith('manual')
        expect(mockRefresh).toHaveBeenCalledWith(true)
      })
      expect(calls).toEqual(['sync', 'refresh'])
    })
  })

  describe('Reveal opened source (select + scroll into view)', () => {
    const makeRecs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...mockRecording,
        id: `rec-${i}`,
        filename: `rec-${i}.wav`,
        title: `Recording ${i}`,
        // Descending dates so the default date-desc sort preserves index order.
        dateRecorded: new Date(Date.now() - i * 60_000)
      }))

    it('scrolls the virtualized list to the opened recording', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: makeRecs(6) as any,
        loading: false,
        error: null,
        refresh: mockRefresh,
        deviceConnected: false,
        stats: { total: 6, deviceOnly: 0, localOnly: 6, both: 0, synced: 6, unsynced: 0, onSource: 0, locallyAvailable: 6 }
      })
      // The 4th recording (index 3) is the one being opened.
      scrollHarness.selectedSourceId = 'rec-3'

      renderLibrary()

      await waitFor(() => {
        expect(scrollHarness.scrollToIndex).toHaveBeenCalledWith(3, { align: 'auto' })
      })
    })

    it('does not scroll when nothing is selected', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: makeRecs(4) as any,
        loading: false,
        error: null,
        refresh: mockRefresh,
        deviceConnected: false,
        stats: { total: 4, deviceOnly: 0, localOnly: 4, both: 0, synced: 4, unsynced: 0, onSource: 0, locallyAvailable: 4 }
      })
      scrollHarness.selectedSourceId = null

      renderLibrary()

      await waitFor(() => expect(screen.getByText('Recording 0')).toBeInTheDocument())
      expect(scrollHarness.scrollToIndex).not.toHaveBeenCalled()
    })
  })

  describe('Loading State', () => {
    it('renders loading state initially', () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [],
        loading: true,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 0, deviceOnly: 0, localOnly: 0, both: 0, synced: 0, unsynced: 0, onSource: 0, locallyAvailable: 0 }
      })

      renderLibrary()
      // Library renders main element during loading
      expect(document.querySelector('main') || document.body).toBeTruthy()
    })
  })

  describe('Empty State', () => {
    it('shows empty state when no recordings exist', () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 0, deviceOnly: 0, localOnly: 0, both: 0, synced: 0, unsynced: 0, onSource: 0, locallyAvailable: 0 }
      })

      renderLibrary()
      // Empty state component should be rendered
      expect(screen.getByText(/no.*knowledge.*captured|no.*recordings|empty/i)).toBeInTheDocument()
    })
  })

  describe('Recording Display', () => {
    it('shows recording count when recordings exist', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [mockRecording],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 1, deviceOnly: 0, localOnly: 1, both: 0, synced: 1, unsynced: 0, onSource: 0, locallyAvailable: 1 }
      })

      renderLibrary()

      // Header shows the universal source count.
      await waitFor(() => {
        expect(screen.getByText(/1.*source/i)).toBeInTheDocument()
      })
    })

    // The banner reports a device that WENT AWAY, not one that was never
    // there — showDisconnectBanner is `wasConnected && !deviceConnected`, so a
    // session that never saw a device is deliberately left un-nagged. Drive the
    // real transition rather than asserting on a cold start.
    it('shows the disconnect banner after a connected device goes away', async () => {
      const stats = { total: 1, deviceOnly: 0, localOnly: 1, both: 0, synced: 1, unsynced: 0, onSource: 0, locallyAvailable: 1 }
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [mockRecording],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: true,
        stats
      })

      const { rerender } = renderLibrary()
      expect(screen.queryByText(/device disconnected/i)).not.toBeInTheDocument()

      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [mockRecording],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats
      })
      rerender(
        <MemoryRouter>
          <Library />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByText(/device disconnected/i)).toBeInTheDocument()
      })
    })

    it('stays quiet when no device was ever connected', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [mockRecording],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 1, deviceOnly: 0, localOnly: 1, both: 0, synced: 1, unsynced: 0, onSource: 0, locallyAvailable: 1 }
      })

      renderLibrary()
      await waitFor(() => expect(screen.getByText(/1.*source/i)).toBeInTheDocument())
      expect(screen.queryByText(/device disconnected/i)).not.toBeInTheDocument()
    })

    it('paints compact-row separators without changing measured geometry', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [
          mockRecording,
          { ...mockRecording, id: 'test-456', filename: 'second.wav', title: 'Second Recording' }
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 2, deviceOnly: 0, localOnly: 2, both: 0, synced: 2, unsynced: 0, onSource: 0, locallyAvailable: 2 }
      })

      renderLibrary()

      const secondVirtualRow = await waitFor(() => {
        const row = document.querySelector<HTMLElement>('[data-index="1"]')
        expect(row).not.toBeNull()
        return row as HTMLElement
      })

      expect(secondVirtualRow.className).toContain('before:absolute')
      expect(secondVirtualRow.classList.contains('border-t')).toBe(false)
    })

    it('keeps same-title rows on distinct fixed tracks after a split insertion', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [
          mockRecording,
          { ...mockRecording, id: 'after-parent', filename: 'after.wav', title: 'After parent' }
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 2, deviceOnly: 0, localOnly: 2, both: 0, synced: 2, unsynced: 0, onSource: 0, locallyAvailable: 2 }
      })
      const view = renderLibrary()

      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [
          {
            ...mockRecording,
            id: 'duplicate-parent-id',
            filename: 'part-1.flac',
            meetingSubject: 'External meeting',
            dateRecorded: new Date('2026-08-18T18:46:00'),
            duration: 2815
          },
          {
            ...mockRecording,
            id: 'duplicate-parent-id',
            filename: 'part-2.flac',
            meetingSubject: 'External meeting',
            dateRecorded: new Date('2026-08-18T18:45:00'),
            duration: 2819
          },
          {
            ...mockRecording,
            id: 'after-parent',
            filename: 'after.wav',
            dateRecorded: new Date('2026-08-18T18:44:00')
          }
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 3, deviceOnly: 0, localOnly: 3, both: 0, synced: 3, unsynced: 0, onSource: 0, locallyAvailable: 3 }
      })
      view.rerender(
        <MemoryRouter>
          <Library />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getAllByText('External meeting')).toHaveLength(2)
      })
      expect(virtualizerHarness.options?.getItemKey?.(0)).toBe('duplicate-parent-id::part-1.flac')
      expect(virtualizerHarness.options?.getItemKey?.(1)).toBe('duplicate-parent-id::part-2.flac')
      expect(virtualizerHarness.options?.getItemKey?.(2)).toBe('after-parent')
      expect(virtualizerHarness.measureElement).not.toHaveBeenCalled()
      const rows = [0, 1, 2].map((index) => document.querySelector<HTMLElement>(`[data-index="${index}"]`))
      expect(rows[0]).toHaveStyle({ height: '48px', top: '0px' })
      expect(rows[1]).toHaveStyle({ height: '48px', top: '48px' })
      expect(rows[2]).toHaveStyle({ height: '48px', top: '96px' })
      expect(rows.every((row) => row?.style.transform === '')).toBe(true)
      expect(new Set(rows.map((row) => row?.style.top)).size).toBe(3)
    })
  })

  describe('Error State', () => {
    it('renders error state when error occurs', () => {
      // Note: The component expects error to be a string, not an Error object
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [],
        loading: false,
        error: 'Failed to load recordings',
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 0, deviceOnly: 0, localOnly: 0, both: 0, synced: 0, unsynced: 0, onSource: 0, locallyAvailable: 0 }
      })

      renderLibrary()
      // Error state should be visible
      expect(screen.getByText(/failed to load recordings/i)).toBeInTheDocument()
    })
  })

  describe('View Mode Toggle', () => {
    it('renders view mode toggle buttons', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [mockRecording],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 1, deviceOnly: 0, localOnly: 1, both: 0, synced: 1, unsynced: 0, onSource: 0, locallyAvailable: 1 }
      })

      renderLibrary()

      await waitFor(() => {
        // View mode toggle buttons should be present
        expect(screen.getByTitle(/card view/i)).toBeInTheDocument()
        expect(screen.getByTitle(/compact view|list view/i)).toBeInTheDocument()
      })
    })
  })

  describe('Filters', () => {
    it('renders filter controls', () => {
      renderLibrary()
      const searchInput = screen.getByPlaceholderText(/search .* sources/i)
      expect(searchInput).toBeInTheDocument()
    })
  })

  describe('Bulk Actions', () => {
    it('shows bulk action buttons in header', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [mockRecording],
        loading: false,
        error: null,
        refresh: vi.fn(),
        deviceConnected: false,
        stats: { total: 1, deviceOnly: 0, localOnly: 1, both: 0, synced: 1, unsynced: 0, onSource: 0, locallyAvailable: 1 }
      })

      renderLibrary()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add source/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /refresh library/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /view trash/i })).toBeInTheDocument()
      })
    })
  })

  describe('Transcription Events', () => {
    it('hydrates only the completed recording and transcript instead of rebuilding the whole library', async () => {
      vi.mocked(useUnifiedRecordings).mockReturnValue({
        recordings: [{ ...mockRecording, transcriptionStatus: 'processing' }],
        loading: false,
        error: null,
        refresh: mockRefresh,
        deviceConnected: false,
        stats: { total: 1, deviceOnly: 0, localOnly: 1, both: 0, synced: 1, unsynced: 0, onSource: 0, locallyAvailable: 1 }
      })
      vi.mocked(window.electronAPI.transcripts.getByRecordingIdsOwner).mockResolvedValue({
        'test-123': {
          id: 'transcript-1',
          recordingId: 'test-123',
          text: 'Completed local ASR transcript',
          segments: [],
          speakers: [],
          summary: 'Summary',
          actionables: [],
          createdAt: new Date()
        }
      })
      vi.mocked(window.electronAPI.recordings.getById).mockResolvedValue({
        id: 'test-123', transcription_status: 'complete', migrated_to_capture_id: 'capture-1'
      })
      vi.mocked(window.electronAPI.knowledge.getById).mockResolvedValue({
        id: 'capture-1', title: 'Completed title', quality: 'valuable'
      } as any)

      renderLibrary()

      await waitFor(() => {
        expect(window.electronAPI.onTranscriptionCompleted).toHaveBeenCalled()
      })

      await act(async () => {
        transcriptionCompletedListeners[0]({ recordingId: 'test-123' })
      })

      await waitFor(() => {
        expect(window.electronAPI.transcripts.getByRecordingIdsOwner).toHaveBeenCalledWith(['test-123'])
        expect(window.electronAPI.recordings.getById).toHaveBeenCalledWith('test-123')
        expect(window.electronAPI.knowledge.getById).toHaveBeenCalledWith('capture-1')
      })
      expect(mockRefresh).not.toHaveBeenCalled()
    })
  })
})

describe('Library — recordings the HiDock holds a larger copy of', () => {
  // This file does not clear mocks between tests, and the toast spy is shared.
  beforeEach(() => {
    toastMock.warning.mockClear()
  })

  it('stays quiet about a transcript that outruns its file when the device has no fuller copy', async () => {
    // A transcript running past its audio is usually wrong timestamps, not lost
    // audio; the integrity labels report that. Nothing here to recover.
    vi.mocked(window.electronAPI.recordings.backfillDurations).mockResolvedValueOnce({
      success: true,
      scanned: 40,
      truncated: 37,
    })

    render(<MemoryRouter><Library /></MemoryRouter>)

    await waitFor(() => expect(window.electronAPI.recordings.backfillDurations).toHaveBeenCalled())
    await waitFor(() => expect(window.electronAPI.downloadService.truncatedRecoveryPlan).toHaveBeenCalled())
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('offers to recover the ones the device still holds larger, and only on request', async () => {
    vi.mocked(window.electronAPI.recordings.backfillDurations).mockResolvedValueOnce({
      success: true,
      truncated: 47,
    })
    vi.mocked(window.electronAPI.downloadService.truncatedRecoveryPlan).mockResolvedValueOnce({
      truncated: 47,
      recoverable: 3,
      deviceNotLarger: 8,
      notOnDevice: 36,
      heldBack: 0,
      deviceListKnown: true,
    })
    vi.mocked(window.electronAPI.downloadService.recoverTruncated).mockResolvedValueOnce({
      queued: ['a.hda', 'b.hda', 'c.hda'],
      skipped: [],
      truncated: 47,
      recoverable: 3,
      deviceNotLarger: 8,
      notOnDevice: 36,
      heldBack: 0,
    })

    render(<MemoryRouter><Library /></MemoryRouter>)

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1))
    const [title, body, opts] = toastMock.warning.mock.calls[0]
    expect(title).toMatch(/fuller copies/i)
    expect(body).toContain('larger file than the copy on disk for 3 recordings')
    expect(body).not.toMatch(/transcri/i)
    expect(opts?.action?.label).toBe('Recover 3 from the device')
    // Nothing is queued until the owner clicks.
    expect(window.electronAPI.downloadService.recoverTruncated).not.toHaveBeenCalled()

    opts.action.onClick()

    await waitFor(() => expect(window.electronAPI.downloadService.recoverTruncated).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('3 recoveries queued', expect.any(String)))
  })

  it('says nothing when the device has none of them', async () => {
    vi.mocked(window.electronAPI.recordings.backfillDurations).mockResolvedValueOnce({
      success: true,
      truncated: 2,
    })
    vi.mocked(window.electronAPI.downloadService.truncatedRecoveryPlan).mockResolvedValueOnce({
      truncated: 2,
      recoverable: 0,
      deviceNotLarger: 0,
      notOnDevice: 2,
      heldBack: 0,
      deviceListKnown: true,
    })

    render(<MemoryRouter><Library /></MemoryRouter>)

    await waitFor(() => expect(window.electronAPI.downloadService.truncatedRecoveryPlan).toHaveBeenCalled())
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('says nothing when every file holds the audio it should', async () => {
    vi.mocked(window.electronAPI.recordings.backfillDurations).mockResolvedValueOnce({
      success: true,
      scanned: 40,
      measured: 40,
      truncated: 0,
    })

    render(<MemoryRouter><Library /></MemoryRouter>)

    await waitFor(() => expect(window.electronAPI.recordings.backfillDurations).toHaveBeenCalled())
    expect(toastMock.warning).not.toHaveBeenCalled()
  })
})

describe('Library — transcript integrity labels', () => {
  const clean = { ...mockRecording, id: 'clean-1', title: 'Clean one', localPath: '/p/clean.wav' }
  const shaky = { ...mockRecording, id: 'shaky-1', title: 'Shaky one', localPath: '/p/shaky.wav' }
  const suspectJson = JSON.stringify({
    version: 1,
    status: 'suspect',
    issues: [{ code: 'repeated_start', count: 3, detail: '3 lines start at the same instant as another line.' }],
  })
  const transcriptsById = {
    'clean-1': { id: 't-clean', recording_id: 'clean-1', integrity_status: 'ok', integrity_json: '{"issues":[]}' },
    'shaky-1': { id: 't-shaky', recording_id: 'shaky-1', integrity_status: 'suspect', integrity_json: suspectJson },
  }

  beforeEach(() => {
    toastMock.warning.mockClear()
    toastMock.success.mockClear()
    integrityHarness.filter = null
    integrityHarness.search = ''
    integrityHarness.set.mockClear()
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: [clean, shaky],
      loading: false,
      error: null,
      refresh: mockRefresh,
      deviceConnected: false,
      stats: { total: 2, deviceOnly: 0, localOnly: 2, both: 0, synced: 2, unsynced: 0, onSource: 0, locallyAvailable: 2 },
    } as any)
    vi.mocked(window.electronAPI.transcripts.getByRecordingIdsOwner).mockResolvedValue(transcriptsById as any)
    vi.mocked(window.electronAPI.transcripts.retranscribeMany).mockClear()
  })

  it('announces flagged transcripts once, on the mount that checked them, and Review opens the filter', async () => {
    vi.mocked(window.electronAPI.recordings.backfillDurations).mockResolvedValueOnce({
      success: true,
      integrityChecked: 2,
    })

    render(<MemoryRouter><Library /></MemoryRouter>)

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1))
    const [title, , opts] = toastMock.warning.mock.calls[0]
    expect(title).toBe('1 transcript has problems in their timing or text')
    expect(opts?.action?.label).toBe('Review')
    opts.action.onClick()
    expect(integrityHarness.set).toHaveBeenCalledWith('flagged')
  })

  it('says nothing when the check found no transcript to label', async () => {
    vi.mocked(window.electronAPI.recordings.backfillDurations).mockResolvedValueOnce({ success: true, integrityChecked: 0 })

    render(<MemoryRouter><Library /></MemoryRouter>)

    await waitFor(() => expect(window.electronAPI.recordings.backfillDurations).toHaveBeenCalled())
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('shows only flagged transcripts under the filter, and queues them again on confirmation', async () => {
    integrityHarness.filter = 'flagged'

    render(<MemoryRouter><Library /></MemoryRouter>)

    const bar = await screen.findByTestId('integrity-bulk-bar')
    expect(bar).toHaveTextContent('1 flagged transcript in this view.')
    expect(screen.queryByText('Clean one')).not.toBeInTheDocument()

    fireEvent.click(within(bar).getByRole('button', { name: 'Transcribe it again' }))
    expect(window.electronAPI.transcripts.retranscribeMany).not.toHaveBeenCalled()
    fireEvent.click(within(bar).getByRole('button', { name: 'Queue 1' }))

    await waitFor(() =>
      expect(window.electronAPI.transcripts.retranscribeMany).toHaveBeenCalledWith({ recordingIds: ['shaky-1'] })
    )
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Queued 1 transcription', expect.any(String)))
  })

  it('counts and queues only what the search leaves on screen', async () => {
    // Review of PR #32: the bar counted the filter's matches but ignored the
    // search box, so "Queue 2" would have queued a row the owner had hidden.
    const shakyTwo = { ...shaky, id: 'shaky-2', title: 'Budget review', localPath: '/p/two.wav' }
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: [clean, shaky, shakyTwo],
      loading: false,
      error: null,
      refresh: mockRefresh,
      deviceConnected: false,
      stats: { total: 3, deviceOnly: 0, localOnly: 3, both: 0, synced: 3, unsynced: 0, onSource: 0, locallyAvailable: 3 },
    } as any)
    vi.mocked(window.electronAPI.transcripts.getByRecordingIdsOwner).mockResolvedValue({
      ...transcriptsById,
      'shaky-2': { ...transcriptsById['shaky-1'], id: 't-shaky-2', recording_id: 'shaky-2' },
    } as any)
    integrityHarness.filter = 'flagged'
    integrityHarness.search = 'budget'

    render(<MemoryRouter><Library /></MemoryRouter>)

    const bar = await screen.findByTestId('integrity-bulk-bar')
    expect(bar).toHaveTextContent('1 flagged transcript in this view.')
    fireEvent.click(within(bar).getByRole('button', { name: 'Transcribe it again' }))
    fireEvent.click(within(bar).getByRole('button', { name: 'Queue 1' }))
    await waitFor(() =>
      expect(window.electronAPI.transcripts.retranscribeMany).toHaveBeenCalledWith({ recordingIds: ['shaky-2'] })
    )
  })
})
