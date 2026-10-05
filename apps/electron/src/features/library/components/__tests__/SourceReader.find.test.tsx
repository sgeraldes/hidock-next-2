/** Reader find expands hidden/collapsed sections and preserves hook order. */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SourceReader } from '../SourceReader'
import { useUIStore } from '@/store/useUIStore'
import { useLibraryStore } from '@/store/useLibraryStore'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Transcript } from '@/types'

vi.mock('../WaveformPlayer', () => ({ WaveformPlayer: () => <div data-testid="waveform-player" /> }))
vi.mock('../TranscriptViewer', () => ({ TranscriptViewer: () => <div data-testid="transcript-viewer" /> }))

vi.mock('@radix-ui/react-portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('@/components/RecordingLinkDialog', () => ({ RecordingLinkDialog: () => null }))
vi.mock('@/components/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
}))

function makeRecording(overrides: Partial<UnifiedRecording> = {}): UnifiedRecording {
  return {
    id: 'rec-1',
    filename: 'meeting.wav',
    size: 1024 * 1024,
    duration: 125,
    dateRecorded: new Date('2024-01-15T10:00:00Z'),
    transcriptionStatus: 'complete',
    location: 'local-only',
    localPath: '/recordings/meeting.wav',
    syncStatus: 'synced',
    ...overrides,
  } as UnifiedRecording
}

function makeTranscript(): Transcript {
  return {
    id: 't-1',
    recording_id: 'rec-1',
    full_text: '[00:30] Speaker 1: Ship it.',
    summary: null,
    action_items: null,
    speakers: JSON.stringify([{ speaker: 'Speaker 1', start: 30, end: 40, text: 'Ship it.' }]),
  } as unknown as Transcript
}

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({ waveformLoadedForId: null, waveformLoadingId: null, playbackDuration: 0 })
  useLibraryStore.setState({ waveformPinned: false })
  ;(window as any).__audioControls = { loadWaveformOnly: vi.fn() }
  Object.defineProperty(window, 'electronAPI', {
    value: {
      recordings: {
        reprocessWith: vi.fn().mockResolvedValue({ success: true }),
        getTimelineAnalysis: vi.fn().mockResolvedValue({ sentimentSegments: [], eventMarkers: [] }),
        analyzeTimeline: vi.fn().mockResolvedValue({ sentimentSegments: [], eventMarkers: [] }),
      },
      transcripts: {
        getSpeakerMap: vi.fn().mockResolvedValue({ success: true, data: [] }),
      },
      turnSpeakers: {
        getOverrides: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getSplits: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getMergeHints: vi.fn().mockResolvedValue({ success: true, data: [] }),
      },
      contacts: { getForMeeting: vi.fn().mockResolvedValue({ success: true, data: [] }), getForMeetingOwner: vi.fn().mockResolvedValue({ success: true, data: [] }), getAll: vi.fn().mockResolvedValue({ success: true, data: { contacts: [] } }) },
      projects: {
        getForKnowledge: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { projects: [], total: 0 } }),
      },
    },
    writable: true,
    configurable: true,
  })
})

describe('SourceReader find section navigation', () => {
  it('expands a hidden summary, restores another maximized section, and seeks transcript matches without play', async () => {
    useLibraryStore.setState({ readerSectionModes: { player: 'expanded', metadata: 'expanded', moments: 'compact', summary: 'hidden', transcript: 'compact' }, readerMaximizedSection: 'player' })
    const seek = vi.fn()
    const transcript = { ...makeTranscript(), summary: 'Ship it in the summary.' } as Transcript
    render(<MemoryRouter><SourceReader recording={makeRecording()} transcript={transcript} onFindSeek={seek} /></MemoryRouter>)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByLabelText('Find in transcript'), { target: { value: 'Ship' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 2'))
    expect(useLibraryStore.getState().readerMaximizedSection).toBeNull()
    expect(useLibraryStore.getState().readerSectionModes.summary).toBe('expanded')
    expect(screen.getByText('Ship', { selector: 'mark' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(useLibraryStore.getState().readerSectionModes.transcript).toBe('expanded')
    fireEvent.keyDown(screen.getByLabelText('Find in transcript'), { key: 'Enter', altKey: true })
    expect(seek).toHaveBeenCalledWith(30000)
  })
  it('keeps hook order stable when opening and closing a source', () => {
    const { rerender } = render(<MemoryRouter><SourceReader recording={null} /></MemoryRouter>)
    rerender(<MemoryRouter><SourceReader recording={makeRecording()} transcript={makeTranscript()} /></MemoryRouter>)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByLabelText('Find in transcript')).toBeInTheDocument()
    rerender(<MemoryRouter><SourceReader recording={null} /></MemoryRouter>)
    expect(screen.queryByLabelText('Find in transcript')).not.toBeInTheDocument()
  })
})
