/**
 * Tests for the titlebar 🔔 NotificationsButton popover — lists live operations
 * (transcriptions + downloads), shows an empty state, and routes "View all" to
 * the shared Operations overlay (the same source the sidebar badge uses).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NotificationsButton } from '../NotificationsButton'
import { useDownloadQueue, useUnifiedRecordings } from '@/store/useAppStore'
import { useTranscriptionStats, useTranscriptionStore } from '@/store/features/useTranscriptionStore'
import { useUIStore } from '@/store/ui/useUIStore'
const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))

// Radix Popover positioning uses ResizeObserver, which jsdom lacks.
class RO {
  observe() {
    /* no-op */
  }
  unobserve() {
    /* no-op */
  }
  disconnect() {
    /* no-op */
  }
}
;(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver =
  (globalThis as unknown as { ResizeObserver?: typeof RO }).ResizeObserver ?? RO

vi.mock('@/store/useAppStore', () => ({ useDownloadQueue: vi.fn(), useUnifiedRecordings: vi.fn(() => []) }))
vi.mock('@/store/features/useTranscriptionStore', () => ({
  useTranscriptionStats: vi.fn(),
  useTranscriptionStore: vi.fn()
}))
vi.mock('@/store/ui/useUIStore', () => ({ useUIStore: vi.fn() }))

const mockStop = vi.fn()
const mockRetry = vi.fn()
const mockUp = vi.fn()
const mockDown = vi.fn()
const mockCancelDownload = vi.fn()
const mockCancelAllDownloads = vi.fn()
vi.mock('@/hooks/useOperations', () => ({
  useOperations: () => ({ cancelDownload: mockCancelDownload, cancelAllDownloads: mockCancelAllDownloads, cancelTranscription: mockStop })
}))

const mockOpenOverlay = vi.fn()

function setup({
  downloads = new Map(),
  queue = new Map(),
  stats = { total: 0, completed: 0, failed: 0, processing: 0, pending: 0, aggregateProgress: 0 }
}: {
  downloads?: Map<string, { filename: string; progress: number; size: number; status?: string }>
  queue?: Map<string, any>
  stats?: { total: number; completed: number; failed: number; processing: number; pending: number; aggregateProgress: number }
} = {}) {
  vi.mocked(useDownloadQueue).mockReturnValue(downloads as any)
  // Library sources for the fixture files; rows are named by these titles.
  vi.mocked(useUnifiedRecordings).mockReturnValue([
    { id: 'r1', filename: '2026-07-10-standup.wav', title: 'Standup' },
    { id: 'r2', filename: '2026-07-10-notes.wav', title: 'Notes' }
  ] as any)
  vi.mocked(useTranscriptionStats).mockReturnValue(stats as any)
  vi.mocked(useTranscriptionStore).mockImplementation((selector: any) => selector({ queue, retry: mockRetry, prioritize: mockUp, deprioritize: mockDown }))
  vi.mocked(useUIStore).mockImplementation((selector: any) => selector({ openOperationsOverlay: mockOpenOverlay }))
}

function txItem(over: Record<string, any> = {}) {
  return {
    id: 't1',
    recordingId: 'r1',
    filename: '2026-07-10-standup.wav',
    status: 'processing',
    progress: 40,
    retryCount: 0,
    attempts: 1,
    priority: 0,
    ...over
  }
}

describe('NotificationsButton', () => {
  it('offers live progress, Stop, source navigation and queued ordering', () => {
    setup({ queue: new Map([['t1', txItem({stage:'voices'})], ['t2', txItem({id:'t2',recordingId:'r2',status:'pending'})]]), stats: {total:2,completed:0,failed:0,processing:1,pending:1,aggregateProgress:20} })
    render(<NotificationsButton />)
    fireEvent.click(screen.getByRole('button', {name:/Notifications:/}))
    expect(screen.getByText(/Separating speakers/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', {name:'Stop'}))
    expect(mockStop).toHaveBeenCalledWith('r1')
    fireEvent.click(screen.getByRole('button', {name:'Move up'}))
    expect(mockUp).toHaveBeenCalledWith('t2')
    fireEvent.click(screen.getByRole('button', {name:'Move down'}))
    expect(mockDown).toHaveBeenCalledWith('t2')
    fireEvent.click(screen.getByRole('button', {name:'Remove from queue'}))
    expect(mockStop).toHaveBeenCalledWith('r2')
    fireEvent.click(screen.getAllByRole('button', {name:'View source'})[0])
    expect(navigate).toHaveBeenCalledWith('/library', {state:{selectedId:'r1',focusProcessing:true}})
  })

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI = {
      downloadService: {
        getState: vi.fn().mockReturnValue(new Promise(() => {})),
        onStateUpdate: vi.fn().mockReturnValue(() => {})
      }
    }
  })

  it('shows an empty state when there is no activity', () => {
    setup()
    render(<NotificationsButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('No recent activity')).toBeInTheDocument()
  })

  it('lists in-flight transcriptions and active downloads', () => {
    setup({
      queue: new Map([['t1', txItem()]]),
      downloads: new Map([['d1', { filename: '2026-07-10-notes.wav', progress: 42, size: 1000, status: 'downloading' }]]),
      stats: { total: 1, completed: 0, failed: 0, processing: 1, pending: 0, aggregateProgress: 40 }
    })
    render(<NotificationsButton />)

    // Badge reflects the active count (1 transcription + 1 download).
    const trigger = screen.getByRole('button', { name: /Notifications: 2 operations in progress/i })
    fireEvent.click(trigger)

    // Rows keep the name; the state is an icon (and the number) with the words in its label.
    expect(screen.getByText('Standup')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Transcribing' })).toHaveAttribute('title', 'Transcribing')
    expect(screen.queryByText(/Transcribing…/)).not.toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.queryByText(/2026-07-10/)).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Downloading, 42%' })).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.queryByText(/Downloading…/)).not.toBeInTheDocument()
  })

  it('routes "View all" to the shared Operations overlay', () => {
    setup({
      queue: new Map([['t1', txItem({ status: 'failed', error: 'nope' })]]),
      stats: { total: 1, completed: 0, failed: 1, processing: 0, pending: 0, aggregateProgress: 0 }
    })
    render(<NotificationsButton />)

    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: /view all in operations/i }))
    expect(mockOpenOverlay).toHaveBeenCalledTimes(1)
  })

  it('includes durable failed downloads in the same failure count as Operations', async () => {
    ;(window as any).electronAPI.downloadService.getState.mockResolvedValue({
      queue: [{
        filename: 'missing.hda',
        fileSize: 38_892,
        progress: 0,
        status: 'failed',
        error: 'USB transfer failed'
      }]
    })
    setup({
      queue: new Map([['t1', txItem({ status: 'failed', error: 'provider failed' })]]),
      stats: { total: 1, completed: 0, failed: 1, processing: 0, pending: 0, aggregateProgress: 0 }
    })
    render(<NotificationsButton />)

    const trigger = await screen.findByRole('button', { name: /2 failed/i })
    fireEvent.click(trigger)
    // No Library source for the file: a neutral label, never the file name.
    expect(screen.getByText('Recording')).toBeInTheDocument()
    expect(screen.getByText(/Failed · USB transfer failed/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('2 failed')).toBeInTheDocument())
  })

  it('offers a per-download Cancel that calls cancelDownload(filename)', () => {
    setup({
      downloads: new Map([['d1', { filename: '2026-07-10-notes.wav', progress: 42, size: 1000, status: 'downloading' }]])
    })
    render(<NotificationsButton />)

    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download Notes' }))
    expect(mockCancelDownload).toHaveBeenCalledWith('2026-07-10-notes.wav')
  })

  it('shows a cancelling row with the cancel control disabled while awaiting settlement', () => {
    setup({
      downloads: new Map([['d1', { filename: 'x.wav', progress: 80, size: 1000, status: 'cancelling' }]])
    })
    render(<NotificationsButton />)

    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }))
    expect(screen.getByRole('img', { name: 'Cancelling' })).toHaveAttribute('title', 'Cancelling')
    expect(screen.queryByText(/Cancelling…/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel download Recording' })).toBeDisabled()
  })

  it('offers a Cancel-all downloads control wired to cancelAllDownloads', () => {
    setup({
      downloads: new Map([
        ['d1', { filename: 'a.wav', progress: 10, size: 1000, status: 'downloading' }],
        ['d2', { filename: 'b.wav', progress: 0, size: 1000, status: 'pending' }]
      ])
    })
    render(<NotificationsButton />)

    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel all downloads' }))
    expect(mockCancelAllDownloads).toHaveBeenCalledTimes(1)
  })

  it('leaves failures from earlier app sessions out of the badge and the list', async () => {
    ;(window as any).electronAPI.downloadService.getState.mockResolvedValue({
      queue: [{
        filename: 'old.hda', fileSize: 10, progress: 0, status: 'failed',
        error: 'USB transfer failed', fromPreviousSession: true
      }]
    })
    setup({
      queue: new Map([['t1', txItem({ status: 'failed', error: 'old', fromPreviousSession: true })]]),
      stats: { total: 1, completed: 0, failed: 1, processing: 0, pending: 0, aggregateProgress: 0 }
    })
    render(<NotificationsButton />)

    await waitFor(() => expect((window as any).electronAPI.downloadService.getState).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('No recent activity')).toBeInTheDocument()
  })
})

 it('shows a stopped-only notification with its saved-result reason and Finish processing', async () => {
   setup({ queue: new Map([['t1', txItem({ status: 'cancelled', error: 'Stopped by you after the transcript was saved; summary/actions/search not updated' })]]) })
   render(<NotificationsButton />)
   fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))
   expect(await screen.findByText('Stopped by you after the transcript was saved; summary/actions/search not updated')).toBeVisible()
   expect(screen.getByText('Stopped', {exact:true})).toBeVisible()
   fireEvent.click(screen.getByRole('button', { name: 'Finish processing' }))
   expect(mockRetry).toHaveBeenCalled()
   expect(screen.getByRole('button', { name: 'Dismiss' })).toBeVisible()
 })
