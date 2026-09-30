/**
 * SourceCard (card view).
 *
 * spec-005/F17 T5 §D3b — the card is a THIRD delete surface, and its label used to
 * LIE for non-device rows ("Delete local file"/"Delete local copy") while routing
 * through a SOFT delete (Move to Trash). The delete now lives in the card's actions
 * menu with the honest label, and AR3-4 still gates it. The card gains no
 * permanent-delete or synced device-delete (the row and the reader carry the full set).
 *
 * 30-sep-2026 — the card is a fixed-size card: title, date and time, chips, one line of
 * content, then the state of the file and of the transcript on the left and the actions on
 * the right. No inline transcript any more; a click opens the reader.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SourceCard } from '../SourceCard'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Meeting, Transcript } from '@/types'
import { useLibraryStore } from '@/store/useLibraryStore'

const baseRecording: UnifiedRecording = {
  id: 'r1',
  filename: 'meeting.wav',
  title: 'Weekly sync',
  size: 1024,
  duration: 5520, // 1h 32m
  dateRecorded: new Date('2026-09-29T22:00:00'),
  transcriptionStatus: 'complete',
  location: 'both',
  localPath: '/data/meeting.wav',
  deviceFilename: 'meeting.hda',
  syncStatus: 'synced'
}

const meeting: Meeting = {
  id: 'm1',
  subject: 'Amazon Connect - Ejecución del cambio',
  start_time: '2026-09-29T22:00:00',
  end_time: '2026-09-29T23:00:00',
  location: null,
  organizer_name: null,
  organizer_email: null,
  attendees: null,
  description: null,
  is_recurring: 0,
  recurrence_rule: null,
  meeting_url: null,
  created_at: '',
  updated_at: ''
}

function makeProps(overrides: Partial<React.ComponentProps<typeof SourceCard>> = {}) {
  return {
    recording: baseRecording,
    isPlaying: false,
    isDownloading: false,
    isDeleting: false,
    deviceConnected: false,
    onClick: vi.fn(),
    onPlay: vi.fn(),
    onStop: vi.fn(),
    onDownload: vi.fn(),
    onDelete: vi.fn(),
    onAskAssistant: vi.fn(),
    onGenerateOutput: vi.fn(),
    onNavigateToMeeting: vi.fn(),
    ...overrides
  }
}

/** Radix opens a menu from the keyboard the same way in jsdom as in the app. */
async function openMenu() {
  fireEvent.keyDown(screen.getByLabelText('Card actions'), { key: 'Enter' })
  await screen.findByRole('menu')
}

describe('SourceCard Explorer-style selection', () => {
  it('plain click opens the card without invoking modifier selection', () => {
    const onClick = vi.fn()
    const onSelectionChange = vi.fn()
    render(<SourceCard {...makeProps({ onClick, onSelectionChange })} />)

    fireEvent.click(screen.getByTestId('source-card'))

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }]
  ])('%s+click toggles the card without opening it', (_label, modifier) => {
    const onClick = vi.fn()
    const onSelectionChange = vi.fn()
    render(<SourceCard {...makeProps({ onClick, onSelectionChange })} />)

    fireEvent.click(screen.getByTestId('source-card'), modifier)

    expect(onSelectionChange).toHaveBeenCalledWith('r1', false)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('Shift+click requests range selection without opening the card', () => {
    const onClick = vi.fn()
    const onSelectionChange = vi.fn()
    render(<SourceCard {...makeProps({ onClick, onSelectionChange })} />)

    fireEvent.click(screen.getByTestId('source-card'), { shiftKey: true })

    expect(onSelectionChange).toHaveBeenCalledWith('r1', true)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('interactive child clicks do not change the card selection', async () => {
    const onClick = vi.fn()
    const onSelectionChange = vi.fn()
    const onAskAssistant = vi.fn()
    render(<SourceCard {...makeProps({ onClick, onSelectionChange, onAskAssistant })} />)

    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /ask assistant/i }), { ctrlKey: true })

    expect(onAskAssistant).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('the Play button plays without opening the card', () => {
    const onClick = vi.fn()
    const onPlay = vi.fn()
    render(<SourceCard {...makeProps({ onClick, onPlay })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('SourceCard delete item — honest label (spec-005/F17 §D3b)', () => {
  it('local-only: reads "Move to Trash" (never "Delete local file")', async () => {
    render(<SourceCard {...makeProps({ recording: { ...baseRecording, location: 'local-only' } })} />)
    await openMenu()
    expect(screen.getByRole('menuitem', { name: /move to trash/i })).toBeInTheDocument()
    expect(screen.queryByText(/delete local file/i)).not.toBeInTheDocument()
  })

  it('both (synced): reads "Move to Trash" (never "Delete local copy")', async () => {
    render(<SourceCard {...makeProps({ recording: { ...baseRecording, location: 'both' } })} />)
    await openMenu()
    expect(screen.getByRole('menuitem', { name: /move to trash/i })).toBeInTheDocument()
    expect(screen.queryByText(/delete local copy/i)).not.toBeInTheDocument()
  })

  it('device-only: reads "Delete from device"', async () => {
    render(
      <SourceCard
        {...makeProps({
          recording: {
            ...baseRecording,
            location: 'device-only',
            localPath: undefined,
            syncStatus: 'not-synced'
          } as unknown as UnifiedRecording,
          deviceConnected: true
        })}
      />
    )
    await openMenu()
    expect(screen.getByRole('menuitem', { name: /delete from device/i })).toBeInTheDocument()
  })

  it('never renders the retired raw strings "Delete local file"/"Delete local copy" in any state', async () => {
    for (const location of ['local-only', 'both', 'device-only'] as const) {
      const { unmount } = render(
        <SourceCard
          {...makeProps({
            recording: { ...baseRecording, location } as UnifiedRecording,
            deviceConnected: true
          })}
        />
      )
      await openMenu()
      expect(screen.queryByText(/delete local file/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/delete local copy/i)).not.toBeInTheDocument()
      unmount()
    }
  })

  it('choosing it still invokes onDelete (soft delete, unchanged routing)', async () => {
    const onDelete = vi.fn()
    render(<SourceCard {...makeProps({ onDelete })} />)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /move to trash/i }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})

describe('SourceCard AR3-4 — capture-only rows show no delete affordance', () => {
  it('renders no delete item for a capture-only (non-recording-backed) row', async () => {
    const captureOnly: UnifiedRecording = {
      ...baseRecording,
      location: 'local-only',
      localPath: '',
      syncStatus: 'synced',
      sourceKind: 'capture' // the explicit buildRecordingMap capture-only stamp (CX-T5-3)
    }
    render(<SourceCard {...makeProps({ recording: captureOnly })} />)
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: /move to trash/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /delete from device/i })).not.toBeInTheDocument()
  })

  it('CX-T5-3: a REAL recording with an empty localPath (nullable file_path) KEEPS its delete item', async () => {
    const nullPathRecording: UnifiedRecording = {
      ...baseRecording,
      location: 'local-only',
      localPath: '',
      syncStatus: 'synced',
      sourceKind: 'recording'
    }
    render(<SourceCard {...makeProps({ recording: nullPathRecording })} />)
    await openMenu()
    expect(screen.getByRole('menuitem', { name: /move to trash/i })).toBeInTheDocument()
  })
})

describe('SourceCard layout — a fixed card', () => {
  it('fills the cell the grid gives it and never grows with its content', () => {
    render(<SourceCard {...makeProps()} />)
    const card = screen.getByTestId('source-card')
    expect(card).toHaveClass('h-full')
    expect(card).toHaveClass('overflow-hidden')
  })

  it('shows the title over at most two lines, then date, time and length', () => {
    render(<SourceCard {...makeProps()} />)
    const title = screen.getByRole('heading', { name: 'Weekly sync' })
    expect(title).toHaveClass('line-clamp-2')
    const meta = screen.getByTestId('card-meta').textContent ?? ''
    expect(meta).toMatch(/Sep 29/)
    expect(meta).toMatch(/10:00\s?PM/i)
    expect(meta).toMatch(/1h 32m/)
    expect(meta).not.toContain('.wav')
  })

  it('shows the chips: stars and kind, the audio check and a low value', () => {
    render(
      <SourceCard
        {...makeProps({
          recording: {
            ...baseRecording,
            evalStarLevel: 4,
            evalKind: 'team_meeting',
            audioCategory: 'silent',
            quality: 'low-value'
          } as UnifiedRecording
        })}
      />
    )
    expect(screen.getByTestId('evaluation-label')).toHaveTextContent('4★')
    expect(screen.getByTestId('audio-label')).toHaveTextContent('Silent')
    expect(screen.getByLabelText('Low value')).toBeInTheDocument()
  })

  it('shows the summary as the content line, and the meeting under it as a link', () => {
    const onNavigateToMeeting = vi.fn()
    const onClick = vi.fn()
    render(
      <SourceCard
        {...makeProps({
          transcript: { id: 't1', summary: 'Cutover plan agreed for Friday.' } as unknown as Transcript,
          meeting,
          onNavigateToMeeting,
          onClick
        })}
      />
    )
    expect(screen.getByTestId('card-summary')).toHaveTextContent('Cutover plan agreed for Friday.')
    fireEvent.click(screen.getByTestId('card-meeting'))
    expect(onNavigateToMeeting).toHaveBeenCalledWith('m1')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('says what to do next when there is no transcript', () => {
    const { rerender } = render(
      <SourceCard {...makeProps({ recording: { ...baseRecording, transcriptionStatus: 'none' } })} />
    )
    expect(screen.getByText('Not transcribed yet.')).toBeInTheDocument()
    rerender(
      <SourceCard
        {...makeProps({
          recording: { ...baseRecording, location: 'device-only', localPath: undefined, transcriptionStatus: 'none' } as unknown as UnifiedRecording
        })}
      />
    )
    expect(screen.getByText(/On the device only/)).toBeInTheDocument()
  })

  it('does not embed a transcript viewer any more', () => {
    render(<SourceCard {...makeProps({ transcript: { id: 't1', word_count: 100 } as unknown as Transcript })} />)
    expect(screen.queryByText(/Transcript \(/)).not.toBeInTheDocument()
    expect(screen.queryByText(/View full transcript/)).not.toBeInTheDocument()
  })
})

describe('SourceCard footer — the same two state places as a row', () => {
  it('shows where the file is and the state of the transcript', () => {
    render(<SourceCard {...makeProps()} />)
    const footer = screen.getByTestId('card-status')
    expect(footer.querySelector('[aria-label="Synced"]')).not.toBeNull()
    expect(footer.querySelector('[aria-label="Transcribed"]')).not.toBeNull()
  })

  it('a transcript problem takes the place of the transcription state', () => {
    render(
      <SourceCard {...makeProps({ recording: { ...baseRecording, evalAudioWarning: 'possible_invented_transcript' } as UnifiedRecording })} />
    )
    const footer = screen.getByTestId('card-status')
    expect(footer.querySelector('[data-testid="transcript-problem"]')).not.toBeNull()
    expect(footer.querySelector('[aria-label="Transcribed"]')).toBeNull()
  })

  it('a processing error takes the place of the location icon', () => {
    useLibraryStore.getState().setRecordingError('r1', {
      type: 'transcription_failed',
      message: 'The provider refused the file',
      recoverable: true
    } as never)
    try {
      render(<SourceCard {...makeProps()} />)
      const footer = screen.getByTestId('card-status')
      expect(footer.querySelector('[data-testid="processing-error"]')).not.toBeNull()
      expect(footer.querySelector('[aria-label="Synced"]')).toBeNull()
    } finally {
      useLibraryStore.getState().clearRecordingError('r1')
    }
  })
})

describe('SourceCard actions', () => {
  it('a device-only recording offers a download; a queued one shows its progress instead', () => {
    const onDownload = vi.fn()
    const deviceOnly = { ...baseRecording, location: 'device-only', localPath: undefined } as unknown as UnifiedRecording
    const { rerender } = render(<SourceCard {...makeProps({ recording: deviceOnly, deviceConnected: true, onDownload })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download to computer' }))
    expect(onDownload).toHaveBeenCalledTimes(1)
    rerender(
      <SourceCard
        {...makeProps({ recording: deviceOnly, deviceConnected: true, downloadStatus: 'downloading', downloadProgress: 40, isDownloading: true })}
      />
    )
    expect(screen.queryByRole('button', { name: 'Download to computer' })).toBeNull()
    expect(screen.getByText('40%')).toBeInTheDocument()
  })

  it('an untranscribed local recording offers Transcribe, disabled while it is queued', () => {
    const onTranscribe = vi.fn()
    const { rerender } = render(
      <SourceCard {...makeProps({ recording: { ...baseRecording, transcriptionStatus: 'none' }, onTranscribe })} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }))
    expect(onTranscribe).toHaveBeenCalledTimes(1)
    rerender(
      <SourceCard {...makeProps({ recording: { ...baseRecording, transcriptionStatus: 'pending' }, onTranscribe })} />
    )
    expect(screen.getByRole('button', { name: 'Transcribe' })).toBeDisabled()
  })

  it('a playing card shows Stop instead of Play', () => {
    const onStop = vi.fn()
    render(<SourceCard {...makeProps({ isPlaying: true, onStop })} />)
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
