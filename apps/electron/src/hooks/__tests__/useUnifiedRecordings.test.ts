import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import {
  buildRecordingMap,
  mapTranscriptionStatus,
  overlayActiveTranscriptionStatuses,
  useUnifiedRecordings
} from '../useUnifiedRecordings'
import { useAppStore } from '@/store/useAppStore'

// Mock dependencies
vi.mock('@/services/hidock-device', () => ({
  getHiDockDeviceService: vi.fn(() => ({
    isConnected: vi.fn(() => false),
    onConnectionChange: vi.fn(() => () => {}),
    onStatusChange: vi.fn(() => () => {}),
    getCachedRecordings: vi.fn(() => []),
    listRecordings: vi.fn(() => [])
  }))
}))

// Mock App Store
vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn()
}))

// Mock toaster to avoid circular dependency issues
vi.mock('@/components/ui/toaster', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }
}))

describe('mapTranscriptionStatus', () => {
  it('projects a local video audio row with its display title and backlink', () => {
    const [audio] = buildRecordingMap([], [{ id: 'audio', filename: 'external.wav', file_path: '/fixture/audio.wav', file_size: 10, status: 'none', parent_video_capture_id: 'video', video_audio_title: 'Clip.mp4 · audio' }], [], [], false)
    expect(audio).toMatchObject({ parentVideoCaptureId: 'video', videoAudioTitle: 'Clip.mp4 · audio' })
  })
  it('preserves no_speech even when a stale previous capture is ready', () => {
    expect(mapTranscriptionStatus('no_speech', 'ready')).toBe('no_speech')
  })

  it('shows an active re-transcription over a stale ready capture', () => {
    expect(mapTranscriptionStatus('processing', 'ready')).toBe('processing')
    expect(mapTranscriptionStatus('pending', 'enriched')).toBe('pending')
  })

  it('overlays live queue state without cloning unaffected recordings', () => {
    const stable = { id: 'stable', transcriptionStatus: 'complete' } as any
    const active = { id: 'active', transcriptionStatus: 'complete' } as any
    const result = overlayActiveTranscriptionStatuses(
      [stable, active],
      new Map([['active', 'processing']])
    )

    expect(result[0]).toBe(stable)
    expect(result[1]).toMatchObject({ id: 'active', transcriptionStatus: 'processing' })
  })
})

describe('buildRecordingMap location facts', () => {
  it('projects the annotated HiDock WAV for its retained HDA alias online and offline', () => {
    const base = '2026Jun01-115550-Rec39'
    const db = [
      { id: 'shadow', filename: `${base}.hda`, original_filename: `${base}.hda`, source: 'hidock', date_recorded: '2026-06-01', file_path: null, file_size: 10, status: 'none', on_local: 0, on_device: 1 },
      { id: 'local', filename: `${base}.wav`, original_filename: `${base}.wav`, source: 'hidock', date_recorded: '2026-06-01', file_path: '/fixture/take.wav', file_size: 10, status: 'complete', on_local: 1, on_device: 1 }
    ]
    const captures = [{ id: 'capture', sourceRecordingId: 'local', userTitle: 'My title', quality: 'valuable', status: 'ready' }] as any
    for (const connected of [false, true]) {
      const result = buildRecordingMap(connected ? [{ id: 'device', filename: `${base}.hda`, size: 10, duration: 60, dateCreated: new Date('2026-06-01') } as any] : [], db, [], [], connected, captures)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ id: 'local', userTitle: 'My title', quality: 'valuable', knowledgeCaptureId: 'capture' })
    }
  })

  // The live database (24-nov-2026) holds 16 of these pairs: an annotated local
  // .wav and a phantom device-only .hda with the same stem, created later by the
  // churn. date_recorded is the UTC instant; the stem is the device's wall clock.
  it('projects and counts the annotated .wav for the 16 live .hda/.wav pairs in any host timezone', () => {
    const pairs: Array<[stem: string, recordedUtc: string, doubtful: boolean]> = [
      ['2026Jun01-115550-Rec39', '2026-06-01T14:55:50.000Z', false],
      ['2026Jun01-135001-Rec41', '2026-06-01T16:50:01.000Z', true],
      ['2026Jun02-010030-Rec44', '2026-06-02T04:00:30.000Z', false],
      ['2026Jun02-140742-Rec47', '2026-06-02T17:07:42.000Z', false],
      ['2026Jun05-105916-Rec76', '2026-06-05T13:59:16.000Z', true],
      ['2026Jun05-112946-Rec77', '2026-06-05T14:29:46.000Z', false],
      ['2026Jun05-223227-Rec89', '2026-06-06T01:32:27.000Z', false],
      ['2026Jun08-105144-Rec93', '2026-06-08T13:51:44.000Z', false],
      ['2026Jun09-110047-Rec00', '2026-06-09T14:00:47.000Z', true],
      ['2026Jun11-120001-Rec13', '2026-06-11T15:00:01.000Z', false],
      ['2026Jun16-170119-Rec38', '2026-06-16T20:01:19.000Z', false],
      ['2026Jun18-094058-Rec46', '2026-06-18T12:40:58.000Z', false],
      ['2026Jun24-143040-Rec76', '2026-06-24T17:30:40.000Z', false],
      ['2026May28-110049-Rec25', '2026-05-28T14:00:49.000Z', true],
      ['2026May28-120314-Rec26', '2026-05-28T15:03:14.000Z', true],
      ['2026May28-170009-Rec30', '2026-05-28T20:00:09.000Z', false]
    ]
    const db = pairs.flatMap(([stem, recorded], i) => [
      { id: `wav-${i}`, filename: `${stem}.wav`, original_filename: `${stem}.wav`, source: 'hidock', is_imported: 0, date_recorded: recorded, file_path: `/fixture/${stem}.wav`, file_size: 10, status: 'complete', transcription_status: 'complete', on_local: 1, on_device: 1, location: 'both', created_at: '2026-06-11 22:22:11', deleted_at: null },
      { id: `hda-${i}`, filename: `${stem}.hda`, original_filename: `${stem}.hda`, source: 'hidock', is_imported: 0, date_recorded: recorded, file_path: null, file_size: 10, status: 'none', transcription_status: 'error', on_local: 0, on_device: 1, location: 'device-only', created_at: '2026-10-14 14:39:12', deleted_at: null }
    ])
    const captures = pairs.map((_, i) => ({ id: `capture-${i}`, sourceRecordingId: `wav-${i}`, userTitle: `Title ${i}`, status: 'ready' })) as any
    const validity = new Map(pairs.map(([, , doubtful], i) => [`wav-${i}`, doubtful ? 'doubtful' : 'valid']))
    const device = pairs.map(([stem, recorded]) => ({ id: `device-${stem}`, filename: `${stem}.hda`, size: 10, duration: 60, dateCreated: new Date(recorded) })) as any
    const savedTz = process.env.TZ
    try {
      for (const tz of ['America/Argentina/Buenos_Aires', 'UTC', 'Asia/Tokyo', 'Asia/Kolkata']) {
        process.env.TZ = tz
        for (const connected of [true, false]) {
          const result = buildRecordingMap(connected ? device : [], db as any, [], [], connected, captures)
          expect(result.map((r) => r.id).sort(), `${tz} connected=${connected}`).toEqual(pairs.map((_, i) => `wav-${i}`).sort())
          expect(result.every((r) => r.knowledgeCaptureId === `capture-${r.id.slice(4)}`)).toBe(true)
          expect(result.filter((r) => validity.get(r.id) === 'doubtful')).toHaveLength(5)
        }
      }
    } finally {
      if (savedTz === undefined) delete process.env.TZ
      else process.env.TZ = savedTz
    }
    // The phantom rows stay in the data; only the projection prefers the .wav.
    expect(db.filter((r) => r.id.startsWith('hda-'))).toHaveLength(16)
  })

  it('keeps an external same-stem import visible beside the independent device take', () => {
    const result = buildRecordingMap([{ id: 'device', filename: 'Rec01.hda', size: 10, duration: 60, dateCreated: new Date('2026-10-05') } as any], [
      { id: 'external', filename: 'Rec01.wav', original_filename: 'Rec01.wav', source: 'external', is_imported: 1, date_recorded: '2026-10-01', file_path: '/fixture/external.wav', file_size: 10, status: 'complete', on_local: 1, on_device: 0 }
    ], [], [], true)
    expect(result.map((r) => r.id).sort()).toEqual(['device', 'external'])
  })

  it('keeps an external same-stem import beside the cached device take while offline', () => {
    const result = buildRecordingMap([], [
      { id: 'external', filename: 'Rec01.wav', original_filename: 'Rec01.wav', source: 'external', is_imported: 1, date_recorded: '2026-10-01', file_path: '/fixture/external.wav', file_size: 10, status: 'complete', on_local: 1, on_device: 0 }
    ] as any, [], [{ filename: 'Rec01.hda', date_recorded: '2026-10-05T10:00:00Z', file_size: 10, duration_seconds: 60 }] as any, false)
    expect(result.map((r) => r.id).sort()).toEqual(['Rec01', 'external'])
  })

  it.each([
    ['a different case', 'take.wav', 'Take.hda', 'Take.hda'],
    ['a legacy local name', '2026-05-28_1037.wav', '2026May28-103745-Rec24.hda', '2026May28-103745-Rec24.hda']
  ])('hides the cached device entry of a downloaded take with %s offline', (_case, filename, original, cached) => {
    const result = buildRecordingMap([], [
      { id: 'local', filename, original_filename: original, source: 'hidock', date_recorded: '2026-05-28', file_path: `/fixture/${filename}`, file_size: 10, status: 'complete', on_local: 1, on_device: 1 }
    ] as any, [], [{ filename: cached, date_recorded: '2026-05-28T10:37:45Z', file_size: 10, duration_seconds: 60 }] as any, false)
    expect(result.map((r) => r.id)).toEqual(['local'])
  })

  it('names the device file by its native name for a downloaded row with no synced match', () => {
    const result = buildRecordingMap([], [
      { id: 'local', filename: '2026Jun01-115550-Rec39.wav', original_filename: '2026Jun01-115550-Rec39.hda', source: 'hidock', date_recorded: '2026-06-01', file_path: '/fixture/take.wav', file_size: 10, status: 'complete', on_local: 1, on_device: 1 },
      { id: 'device', filename: '2026Jun02-140742-Rec47.mp3', original_filename: '2026Jun02-140742-Rec47.hda', source: 'hidock', date_recorded: '2026-06-02', file_path: null, file_size: 10, status: 'none', on_local: 0, on_device: 1 }
    ] as any, [], [], false)
    expect(Object.fromEntries(result.map((r) => [r.id, (r as { deviceFilename?: string }).deviceFilename])))
      .toEqual({ local: '2026Jun01-115550-Rec39.hda', device: '2026Jun02-140742-Rec47.hda' })
  })

  it('keeps an independent import on its own audio path despite a device synced-file alias', () => {
    const result = buildRecordingMap([], [
      { id: 'external', filename: 'Rec01.wav', source: 'external', is_imported: 1, file_path: '/fixture/external.wav', file_size: 10, status: 'complete', on_local: 1 }
    ], [{ id: 'synced-device', original_filename: 'Rec01.hda', local_filename: 'Rec01.wav', file_path: '/fixture/device.wav', synced_at: '2026-10-05' }], [], false)
    expect(result[0]).toMatchObject({ id: 'external', localPath: '/fixture/external.wav' })
  })
  const device = {
    id: 'device-id',
    filename: '2026Aug18-120000-Rec01.hda',
    size: 1024,
    duration: 60,
    dateCreated: new Date('2026-08-18T12:00:00')
  } as any

  it('does not paint a durable device-only metadata row as synced', () => {
    const [recording] = buildRecordingMap([device], [{
      id: 'rec-1',
      filename: device.filename,
      file_path: '',
      file_size: 1024,
      status: 'new',
      on_local: 0,
      on_device: 1,
      location: 'device-only'
    }], [], [], true)

    expect(recording).toMatchObject({ location: 'device-only', syncStatus: 'not-synced' })
  })

  it('retains both locations from durable facts while the device is offline', () => {
    const [recording] = buildRecordingMap([], [{
      id: 'rec-1',
      filename: device.filename,
      file_path: 'F:/recordings/recording.mp3',
      file_size: 1024,
      status: 'new',
      on_local: 1,
      on_device: 1,
      location: 'both'
    }], [], [], false)

    expect(recording).toMatchObject({ location: 'both', syncStatus: 'synced' })
  })

  it('does not resurrect a reconciled-away recording as device-only', () => {
    const recordings = buildRecordingMap([], [{
      id: 'erased-source',
      filename: '2026Aug18-210520-Rec99.hda',
      file_path: null,
      file_size: 38892,
      status: 'none',
      on_local: 0,
      on_device: 0,
      location: 'deleted'
    }], [], [], true)

    expect(recordings).toEqual([])
  })

  it('does not resurrect a soft-deleted split source that remains on the device', () => {
    const child = {
      id: 'split-child-1',
      filename: '2026Aug18-120000-Rec01 - Part 1.flac',
      file_path: 'F:/recordings/2026Aug18-120000-Rec01 - Part 1.flac',
      file_size: 512,
      duration_seconds: 30,
      date_recorded: '2026-08-18T12:00:00',
      status: 'new',
      on_local: 1,
      on_device: 0,
      location: 'local-only' as const
    }
    const synced = [{
      id: 'synced-parent',
      original_filename: device.filename,
      local_filename: '2026Aug18-120000-Rec01.flac',
      file_path: 'F:/recordings/2026Aug18-120000-Rec01.flac',
      synced_at: '2026-08-18T12:01:00'
    }]
    const tombstone = [{
      id: 'split-parent',
      filename: '2026Aug18-120000-Rec01.flac',
      file_path: 'F:/recordings/2026Aug18-120000-Rec01.flac',
      file_size: 1024,
      status: 'complete',
      deleted_at: '2026-08-18T13:00:00'
    }]

    const recordings = buildRecordingMap(
      [device],
      [child],
      synced,
      [],
      true,
      [],
      tombstone
    )

    expect(recordings.map((recording) => recording.id)).toEqual(['split-child-1'])
    expect(recordings.some((recording) => recording.filename === device.filename)).toBe(false)
  })

  it('keeps nearby device recordings distinct when one has an exact database match', () => {
    const exactDeviceRecording = {
      id: 'device-exact',
      filename: '2026Aug18-184600-Rec95.hda',
      size: 2048,
      duration: 2815,
      dateCreated: new Date('2026-08-18T18:46:00')
    } as any
    const nearbyDeviceRecording = {
      id: 'device-nearby',
      filename: '2026Aug18-184525-Rec94.hda',
      size: 128,
      duration: 30,
      dateCreated: new Date('2026-08-18T18:45:25')
    } as any
    const databaseRecording = {
      id: 'database-exact',
      filename: exactDeviceRecording.filename,
      file_path: 'F:/recordings/2026Aug18-184600-Rec95.wav',
      file_size: 2048,
      duration_seconds: 2815,
      date_recorded: '2026-08-18T18:46:00',
      status: 'complete',
      on_local: 1,
      on_device: 1,
      location: 'both' as const
    }

    // Put the nearby recording first to reproduce the device ordering that
    // previously let it claim database-exact through the 60-second fallback.
    const recordings = buildRecordingMap(
      [nearbyDeviceRecording, exactDeviceRecording],
      [databaseRecording],
      [],
      [],
      true
    )

    expect(recordings).toHaveLength(2)
    expect(recordings.find((recording) => recording.filename === exactDeviceRecording.filename)?.id)
      .toBe('database-exact')
    expect(recordings.find((recording) => recording.filename === nearbyDeviceRecording.filename)?.id)
      .toBe('device-nearby')
    expect(new Set(recordings.map((recording) => recording.id)).size).toBe(recordings.length)
  })
})

// Mock Electron API
function createMockElectronAPI() {
  return {
    recordings: {
      getAll: vi.fn().mockResolvedValue([]),
      getTrash: vi.fn().mockResolvedValue([])
    },
    syncedFiles: { getAll: vi.fn().mockResolvedValue([]) },
    deviceCache: { getAll: vi.fn().mockResolvedValue([]), saveAll: vi.fn().mockResolvedValue(undefined) },
    // ROUND-15 RESIDUAL — the hook now calls the owner accessor. Alias getAll to
    // the same fn so existing tests that drive/assert `knowledge.getAll` still
    // resolve the value the hook consumes via getAllOwner.
    knowledge: (() => {
      const captures = vi.fn().mockResolvedValue([])
      return { getAll: captures, getAllOwner: captures }
    })(),
    onRecordingAdded: vi.fn(() => vi.fn())
  } as any
}

global.window.electronAPI = createMockElectronAPI()

describe('useUnifiedRecordings', () => {
  let storeState: any

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset electronAPI mock
    global.window.electronAPI = createMockElectronAPI()

    storeState = {
      unifiedRecordings: [],
      unifiedRecordingsLoading: false,
      unifiedRecordingsLoadingCount: 0,
      unifiedRecordingsError: null,
      unifiedRecordingsLoaded: false,
      deviceState: { connected: false, model: null },
      setUnifiedRecordings: vi.fn(),
      setUnifiedRecordingsLoading: vi.fn(),
      incrementUnifiedRecordingsLoading: vi.fn(),
      decrementUnifiedRecordingsLoading: vi.fn(),
      setUnifiedRecordingsError: vi.fn(),
      markUnifiedRecordingsLoaded: vi.fn()
    }
    // @ts-ignore - useAppStore is vi-mocked, so mockImplementation exists at runtime
    useAppStore.mockImplementation((selector: any) => selector(storeState))
  })

  // ============================================================
  // Basic data fetching
  // ============================================================

  describe('data fetching', () => {
    it('reports the canonical app-store connection state used by the title bar', () => {
      storeState.deviceState = { connected: true, model: 'hidock-h1e' }

      const { result } = renderHook(() => useUnifiedRecordings())

      expect(result.current.deviceConnected).toBe(true)
    })

    it('fetches knowledge captures and recordings on mount', async () => {
      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(window.electronAPI.knowledge.getAllOwner).toHaveBeenCalled()
        expect(window.electronAPI.recordings.getAll).toHaveBeenCalled()
      })
    })

    it('fetches synced files and device cache on mount', async () => {
      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(window.electronAPI.syncedFiles.getAll).toHaveBeenCalled()
        expect(window.electronAPI.deviceCache.getAll).toHaveBeenCalled()
      })
    })

    it('increments loading counter during fetch', async () => {
      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.incrementUnifiedRecordingsLoading).toHaveBeenCalled()
      })
    })

    it('marks loaded after successful fetch', async () => {
      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.markUnifiedRecordingsLoaded).toHaveBeenCalled()
      })
    })

    it('decrements loading counter after fetch completes', async () => {
      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.decrementUnifiedRecordingsLoading).toHaveBeenCalled()
      })
    })
  })

  // ============================================================
  // Knowledge capture mapping
  // ============================================================

  describe('knowledge capture mapping', () => {
    it('maps knowledge captures to recordings by sourceRecordingId', async () => {
      const mockRecs = [{
        id: 'rec-1',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        file_size: 100,
        status: 'complete',
        date_recorded: '2025-01-01T10:00:00Z'
      }]
      const mockCaptures = [{
        id: 'cap-1',
        sourceRecordingId: 'rec-1',
        title: 'Better Title',
        quality: 'valuable',
        status: 'ready'
      }]

      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockResolvedValue(mockRecs)
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.knowledge.getAll.mockResolvedValue(mockCaptures)

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.setUnifiedRecordings).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({
            id: 'rec-1',
            title: 'Better Title',
            quality: 'valuable',
            transcriptionStatus: 'complete'
          })
        ]))
      })
    })

    // F16/spec-003 Part A — qualityReasons/qualitySource must thread through
    // to the UnifiedRecording, alongside `quality`, so SourceRow's value
    // badge/tooltip has the data it needs.
    it('threads qualityReasons and qualitySource from the knowledge capture', async () => {
      const mockRecs = [{
        id: 'rec-1',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        file_size: 100,
        status: 'complete',
        date_recorded: '2025-01-01T10:00:00Z'
      }]
      const mockCaptures = [{
        id: 'cap-1',
        sourceRecordingId: 'rec-1',
        title: 'Low value capture',
        quality: 'low-value',
        qualityReasons: ['personal_family', 'background_ambient'],
        qualitySource: 'ai',
        status: 'ready'
      }]

      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockResolvedValue(mockRecs)
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.knowledge.getAll.mockResolvedValue(mockCaptures)

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.setUnifiedRecordings).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({
            id: 'rec-1',
            quality: 'low-value',
            qualityReasons: ['personal_family', 'background_ambient'],
            qualitySource: 'ai'
          })
        ]))
      })
    })

    it('leaves title undefined when no knowledge capture exists', async () => {
      const mockRecs = [{
        id: 'rec-1',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        file_size: 100,
        status: 'complete',
        date_recorded: '2025-01-01T10:00:00Z'
      }]
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockResolvedValue(mockRecs)
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.knowledge.getAll.mockResolvedValue([])

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        const call = storeState.setUnifiedRecordings.mock.calls.find((c: any) => c[0].length > 0)
        if (call) {
          expect(call[0][0].filename).toBe('test.wav')
          expect(call[0][0].title).toBeUndefined()
        }
      })
    })
  })

  // ============================================================
  // sourceKind stamps (CX-T5-3, spec-005/F17 fix round) — the explicit
  // discriminator every deletion affordance gates on. buildRecordingMap's
  // capture-only branch is the ONLY 'capture' producer; every row built
  // from a recordings-table row is 'recording' EVEN when its nullable
  // file_path is null/empty (the old path inference misread that).
  // ============================================================

  describe('sourceKind stamps (CX-T5-3)', () => {
    it('stamps a DB recording "recording" even when its file_path is null', async () => {
      const mockRecs = [{
        id: 'rec-null-path',
        filename: 'no-path.wav',
        file_path: null,
        file_size: 100,
        status: 'complete',
        date_recorded: '2025-01-01T10:00:00Z'
      }]
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockResolvedValue(mockRecs)
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.knowledge.getAll.mockResolvedValue([])

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.setUnifiedRecordings).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({ id: 'rec-null-path', sourceKind: 'recording' })
        ]))
      })
    })

    it('stamps a capture-only synthetic row "capture" (the ONLY capture producer)', async () => {
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockResolvedValue([])
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.knowledge.getAll.mockResolvedValue([{
        id: 'cap-standalone',
        title: 'Imported PDF',
        status: 'ready'
        // no sourceRecordingId — the capture-only synthesis branch
      }])

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.setUnifiedRecordings).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({ id: 'cap-standalone', sourceKind: 'capture' })
        ]))
      })
    })

    it('stamps a recording-backed capture row "recording" (sourceRecordingId set)', async () => {
      const mockRecs = [{
        id: 'rec-1',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        file_size: 100,
        status: 'complete',
        date_recorded: '2025-01-01T10:00:00Z'
      }]
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockResolvedValue(mockRecs)
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.knowledge.getAll.mockResolvedValue([{
        id: 'cap-1',
        sourceRecordingId: 'rec-1',
        title: 'Backed capture',
        status: 'ready'
      }])

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.setUnifiedRecordings).toHaveBeenCalledWith(expect.arrayContaining([
          expect.objectContaining({ id: 'rec-1', sourceKind: 'recording' })
        ]))
      })
    })
  })

  // ============================================================
  // Stats computation
  // ============================================================

  describe('stats computation', () => {
    it('returns zero stats when there are no recordings', () => {
      storeState.unifiedRecordings = []

      const { result } = renderHook(() => useUnifiedRecordings())

      expect(result.current.stats).toEqual({
        total: 0,
        deviceOnly: 0,
        localOnly: 0,
        both: 0,
        synced: 0,
        unsynced: 0,
        onSource: 0,
        locallyAvailable: 0,
      })
    })

    it('correctly counts recordings by location type', () => {
      storeState.unifiedRecordings = [
        { location: 'device-only', syncStatus: 'not-synced' },
        { location: 'device-only', syncStatus: 'not-synced' },
        { location: 'local-only', syncStatus: 'synced' },
        { location: 'both', syncStatus: 'synced' },
        { location: 'both', syncStatus: 'synced' },
        { location: 'both', syncStatus: 'synced' },
      ]
      storeState.unifiedRecordingsLoaded = true

      const { result } = renderHook(() => useUnifiedRecordings())

      expect(result.current.stats.total).toBe(6)
      expect(result.current.stats.deviceOnly).toBe(2)
      expect(result.current.stats.localOnly).toBe(1)
      expect(result.current.stats.both).toBe(3)
    })

    it('correctly counts sync status', () => {
      storeState.unifiedRecordings = [
        { location: 'device-only', syncStatus: 'not-synced' },
        { location: 'local-only', syncStatus: 'synced' },
        { location: 'both', syncStatus: 'synced' },
        { location: 'device-only', syncStatus: 'syncing' },
      ]
      storeState.unifiedRecordingsLoaded = true

      const { result } = renderHook(() => useUnifiedRecordings())

      expect(result.current.stats.synced).toBe(2)
      expect(result.current.stats.unsynced).toBe(2)
    })

    it('computes semantic onSource count (device-only + both)', () => {
      storeState.unifiedRecordings = [
        { location: 'device-only', syncStatus: 'not-synced' },
        { location: 'device-only', syncStatus: 'not-synced' },
        { location: 'both', syncStatus: 'synced' },
        { location: 'local-only', syncStatus: 'synced' },
      ]
      storeState.unifiedRecordingsLoaded = true

      const { result } = renderHook(() => useUnifiedRecordings())

      // onSource = device-only(2) + both(1) = 3
      expect(result.current.stats.onSource).toBe(3)
    })

    it('computes semantic locallyAvailable count (local-only + both)', () => {
      storeState.unifiedRecordings = [
        { location: 'device-only', syncStatus: 'not-synced' },
        { location: 'both', syncStatus: 'synced' },
        { location: 'both', syncStatus: 'synced' },
        { location: 'local-only', syncStatus: 'synced' },
        { location: 'local-only', syncStatus: 'synced' },
      ]
      storeState.unifiedRecordingsLoaded = true

      const { result } = renderHook(() => useUnifiedRecordings())

      // locallyAvailable = local-only(2) + both(2) = 4
      expect(result.current.stats.locallyAvailable).toBe(4)
    })
  })

  // ============================================================
  // Error handling
  // ============================================================

  describe('error handling', () => {
    it('sets error state when recordings fetch fails', async () => {
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockRejectedValue(new Error('Database error'))

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.setUnifiedRecordingsError).toHaveBeenCalledWith('Database error')
      })
    })

    it('sets error state with generic message for non-Error exceptions', async () => {
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockRejectedValue('string error')

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.setUnifiedRecordingsError).toHaveBeenCalledWith('Failed to load recordings')
      })
    })

    it('decrements loading counter on error', async () => {
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.recordings.getAll.mockRejectedValue(new Error('Fetch failed'))

      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.decrementUnifiedRecordingsLoading).toHaveBeenCalled()
      })
    })

    it('clears error state before loading', async () => {
      renderHook(() => useUnifiedRecordings())

      await waitFor(() => {
        expect(storeState.setUnifiedRecordingsError).toHaveBeenCalledWith(null)
      })
    })
  })

  // ============================================================
  // electronAPI guard - crash prevention
  // ============================================================

  describe('electronAPI guard - crash prevention', () => {
    it('does not crash when window.electronAPI is undefined', () => {
      const savedAPI = window.electronAPI
      // @ts-ignore - simulate a non-Electron environment
      delete window.electronAPI

      try {
        expect(() => {
          renderHook(() => useUnifiedRecordings())
        }).not.toThrow()
      } finally {
        window.electronAPI = savedAPI
      }
    })

    it('returns empty recordings when electronAPI is undefined', async () => {
      const savedAPI = window.electronAPI
      // @ts-ignore - simulate a non-Electron environment
      delete window.electronAPI

      try {
        renderHook(() => useUnifiedRecordings())

        await waitFor(() => {
          expect(storeState.setUnifiedRecordings).toHaveBeenCalledWith([])
        })
      } finally {
        window.electronAPI = savedAPI
      }
    })

    it('does not crash when electronAPI.onRecordingAdded is undefined', () => {
      const savedAPI = window.electronAPI
      // @ts-ignore - install a deliberately partial electronAPI for this case
      window.electronAPI = { recordings: { getAll: vi.fn().mockResolvedValue([]) } }

      try {
        expect(() => {
          renderHook(() => useUnifiedRecordings())
        }).not.toThrow()
      } finally {
        window.electronAPI = savedAPI
      }
    })

    it('does not crash when electronAPI.recordings is undefined', () => {
      const savedAPI = window.electronAPI
      // @ts-ignore - install a deliberately partial electronAPI for this case
      window.electronAPI = { onRecordingAdded: vi.fn(() => vi.fn()) }

      try {
        expect(() => {
          renderHook(() => useUnifiedRecordings())
        }).not.toThrow()
      } finally {
        window.electronAPI = savedAPI
      }
    })
  })

  // ============================================================
  // Return value shape
  // ============================================================

  describe('return value shape', () => {
    it('returns all expected fields', () => {
      const { result } = renderHook(() => useUnifiedRecordings())

      expect(result.current).toHaveProperty('recordings')
      expect(result.current).toHaveProperty('loading')
      expect(result.current).toHaveProperty('error')
      expect(result.current).toHaveProperty('refresh')
      expect(result.current).toHaveProperty('deviceConnected')
      expect(result.current).toHaveProperty('stats')
    })

    it('returns recordings as an array', () => {
      const { result } = renderHook(() => useUnifiedRecordings())

      expect(Array.isArray(result.current.recordings)).toBe(true)
    })

    it('returns refresh as a function', () => {
      const { result } = renderHook(() => useUnifiedRecordings())

      expect(typeof result.current.refresh).toBe('function')
    })

    it('returns deviceConnected as boolean', () => {
      const { result } = renderHook(() => useUnifiedRecordings())

      expect(typeof result.current.deviceConnected).toBe('boolean')
    })

    it('stats has all expected numeric fields', () => {
      const { result } = renderHook(() => useUnifiedRecordings())
      const { stats } = result.current

      expect(typeof stats.total).toBe('number')
      expect(typeof stats.deviceOnly).toBe('number')
      expect(typeof stats.localOnly).toBe('number')
      expect(typeof stats.both).toBe('number')
      expect(typeof stats.synced).toBe('number')
      expect(typeof stats.unsynced).toBe('number')
      expect(typeof stats.onSource).toBe('number')
      expect(typeof stats.locallyAvailable).toBe('number')
    })
  })

  // ============================================================
  // Skip loading when already loaded
  // ============================================================

  describe('skip loading when already loaded', () => {
    it('does not re-fetch when already loaded', async () => {
      storeState.unifiedRecordingsLoaded = true

      renderHook(() => useUnifiedRecordings())

      // Mount effects run in declaration order, and a wrongly-triggered load calls
      // recordings.getAll() synchronously inside the initial-load effect body. So once
      // the later-declared recording-watcher effect has subscribed, the load-or-skip
      // decision has already been made — wait for that instead of a fixed sleep.
      await vi.waitFor(
        () => expect(window.electronAPI.onRecordingAdded).toHaveBeenCalled(),
        { timeout: 15000, interval: 25 }
      )

      // Should NOT have called any API because data is already loaded
      expect(window.electronAPI.recordings.getAll).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // Recording watcher subscription
  // ============================================================

  describe('recording watcher subscription', () => {
    it('subscribes to onRecordingAdded events', () => {
      renderHook(() => useUnifiedRecordings())

      expect(window.electronAPI.onRecordingAdded).toHaveBeenCalled()
    })

    it('returns unsubscribe function from onRecordingAdded', () => {
      const unsubscribeFn = vi.fn()
      // @ts-ignore - electronAPI members are vi.fn mocks in tests
      window.electronAPI.onRecordingAdded.mockReturnValue(unsubscribeFn)

      const { unmount } = renderHook(() => useUnifiedRecordings())
      unmount()

      // The unsubscribe function should be called on unmount
      expect(unsubscribeFn).toHaveBeenCalled()
    })

    it('coalesces a burst of discovery events into one cache-only library rebuild', async () => {
      vi.useFakeTimers()
      try {
        storeState.unifiedRecordingsLoaded = true
        let callback: ((data: { recording: { filename: string }; count?: number }) => void) | undefined
        // @ts-ignore - electronAPI members are vi.fn mocks in tests
        window.electronAPI.onRecordingAdded.mockImplementation((next) => {
          callback = next
          return vi.fn()
        })

        renderHook(() => useUnifiedRecordings())

        act(() => {
          callback?.({ recording: { filename: 'old-1.hda' } })
          callback?.({ recording: { filename: 'old-2.hda' } })
          callback?.({ recording: { filename: 'newest.hda' }, count: 18 })
        })
        expect(window.electronAPI.recordings.getAll).not.toHaveBeenCalled()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(100)
        })

        expect(window.electronAPI.recordings.getAll).toHaveBeenCalledTimes(1)
        expect(window.electronAPI.syncedFiles.getAll).toHaveBeenCalledTimes(1)
        expect(window.electronAPI.deviceCache.getAll).toHaveBeenCalledTimes(1)
        expect(window.electronAPI.knowledge.getAllOwner).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
