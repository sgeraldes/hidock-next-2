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
import { render, screen, fireEvent, within } from '@testing-library/react'
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

  it('shows the chips: stars and kind capped by the audio check, and a low value', () => {
    render(
      <SourceCard
        {...makeProps({
          recording: {
            ...baseRecording,
            evalStarLevel: 4,
            evalKind: 'team_meeting',
            evalContext: 'work',
            audioCategory: 'silent',
            quality: 'low-value'
          } as UnifiedRecording
        })}
      />
    )
    // Never "4★ Team meeting" next to "Silent" (owner, 3-oct-2026).
    expect(screen.getByTestId('evaluation-label')).toHaveTextContent('1★')
    expect(screen.getByTestId('evaluation-label')).not.toHaveTextContent('Team meeting')
    expect(screen.getByTestId('evaluation-label')).toHaveAttribute('aria-label', expect.not.stringContaining('Work'))
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

  it('hides the summary of a transcript that does not match its audio', () => {
    render(
      <SourceCard
        {...makeProps({
          transcript: {
            id: 't1',
            summary: 'Laura confiesa que lo mató.',
            integrity_status: 'broken',
            integrity_json: JSON.stringify({ issues: [{ code: 'text_over_noise', count: 1, detail: '' }] }),
            integrity_accepted_at: null
          } as unknown as Transcript
        })}
      />
    )
    expect(screen.queryByTestId('card-summary')).toBeNull()
    expect(screen.queryByText(/Laura confiesa/)).toBeNull()
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
    // The progress sits in the file-status place, like the list rows.
    const place = screen.getByTestId('card-status')
    expect(within(place).getByText('40%')).toBeInTheDocument()
    expect(within(place).getByLabelText('Downloading from the device: 40%')).toBeInTheDocument()
    expect(screen.getAllByText('40%')).toHaveLength(1)
  })

  it('a queued or starting download shows an icon in the file place, never the words', () => {
    const deviceOnly = { ...baseRecording, location: 'device-only', localPath: undefined } as unknown as UnifiedRecording
    const { rerender } = render(
      <SourceCard {...makeProps({ recording: deviceOnly, deviceConnected: true, downloadStatus: 'pending', isDownloading: false })} />
    )
    const place = () => screen.getByTestId('card-status')
    expect(within(place()).getByLabelText('Waiting to download from the device')).toBeInTheDocument()
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
    rerender(
      <SourceCard {...makeProps({ recording: deviceOnly, deviceConnected: true, downloadStatus: 'downloading', downloadProgress: 0, isDownloading: true })} />
    )
    expect(within(place()).getByLabelText('Starting the download from the device')).toBeInTheDocument()
    expect(screen.queryByText('Starting')).not.toBeInTheDocument()
  })

  it('an untranscribed local recording offers Transcribe, and none while the transcription is queued or running', () => {
    const onTranscribe = vi.fn()
    const { rerender } = render(
      <SourceCard {...makeProps({ recording: { ...baseRecording, transcriptionStatus: 'none' }, onTranscribe })} />
    )
    const button = screen.getByRole('button', { name: 'Transcribe' })
    expect(button).toHaveTextContent('Transcribe')
    fireEvent.click(button)
    expect(onTranscribe).toHaveBeenCalledTimes(1)
    for (const status of ['pending', 'processing'] as const) {
      rerender(<SourceCard {...makeProps({ recording: { ...baseRecording, transcriptionStatus: status }, onTranscribe })} />)
      expect(screen.queryByRole('button', { name: /transcribe/i })).toBeNull()
    }
  })

  it('a playing card shows Stop instead of Play', () => {
    const onStop = vi.fn()
    render(<SourceCard {...makeProps({ isPlaying: true, onStop })} />)
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

describe('SourceCard carries more, in the space it has', () => {
  const analysed = {
    id: 't1',
    summary: 'Cutover agreed.',
    action_items: JSON.stringify(['send plan', 'book window', 'tell Itaú']),
    key_points: JSON.stringify(['Friday window', 'no rollback', 'owner is Ana', 'freeze at noon'])
  } as unknown as Transcript

  it('shows how many actions and key points the analysis found, at the right of the date line', () => {
    render(<SourceCard {...makeProps({ transcript: analysed })} />)
    const counts = screen.getByTestId('card-counts')
    expect(screen.getByTestId('card-actions-count')).toHaveTextContent('3')
    expect(screen.getByTestId('card-actions-count')).toHaveAttribute('aria-label', '3 action items')
    expect(screen.getByTestId('card-keypoints-count')).toHaveTextContent('4')
    expect(screen.getByTestId('card-keypoints-count')).toHaveAttribute('aria-label', '4 key points, decisions included')
    // Same line as the date, not a line of their own.
    expect(counts.parentElement).toBe(screen.getByTestId('card-meta').parentElement)
  })

  it('shows no counts for a transcript that was never analysed', () => {
    render(<SourceCard {...makeProps({ transcript: { id: 't2' } as unknown as Transcript })} />)
    expect(screen.queryByTestId('card-counts')).toBeNull()
  })

  it('shows the invited of the meeting as small circles on the chips line', () => {
    const meeting = {
      id: 'm1',
      subject: 'Weekly',
      start_time: '2026-09-29T22:00:00',
      attendees: JSON.stringify([{ name: 'Ana Pérez' }, { name: 'Luis Gómez' }])
    } as unknown as Meeting
    render(<SourceCard {...makeProps({ meeting })} />)
    const people = screen.getByTestId('card-people')
    expect(people.parentElement).toBe(screen.getByTestId('card-chips').parentElement)
    expect(screen.getAllByRole('img').filter((el) => el.getAttribute('data-spoke') === 'false')).toHaveLength(2)
  })

  it('says what is wrong in the body, with the tone of how bad it is', () => {
    const { rerender } = render(
      <SourceCard {...makeProps({ recording: { ...baseRecording, evalAudioWarning: 'possible_invented_transcript' } as UnifiedRecording })} />
    )
    const warning = screen.getByTestId('card-notice')
    expect(warning).toHaveAttribute('data-tone', 'warning')
    expect(warning).toHaveTextContent('Transcript may be invented')
    expect(warning).toHaveClass('line-clamp-2')
    expect(screen.queryByTestId('card-summary')).toBeNull()
    rerender(<SourceCard {...makeProps({ recording: { ...baseRecording, transcriptionStatus: 'error' } })} />)
    expect(screen.getByTestId('card-notice')).toHaveAttribute('data-tone', 'error')
    expect(screen.getByTestId('card-notice')).toHaveTextContent('The transcription failed.')
  })

  it('offers Retry next to a failed transcription, and runs it', () => {
    const onTranscribe = vi.fn()
    render(<SourceCard {...makeProps({ recording: { ...baseRecording, transcriptionStatus: 'error' }, onTranscribe })} />)
    const retry = screen.getByRole('button', { name: 'Retry transcription' })
    expect(retry).toHaveTextContent('Retry')
    fireEvent.click(retry)
    expect(onTranscribe).toHaveBeenCalledTimes(1)
  })

  it('offers Retry for a failed download, and Download otherwise; Download waits for the device', () => {
    const deviceOnly = { ...baseRecording, location: 'device-only', localPath: undefined, transcriptionStatus: 'none' } as unknown as UnifiedRecording
    const onDownload = vi.fn()
    useLibraryStore.getState().setRecordingError('r1', {
      type: 'download_failed',
      message: 'The dock stopped sending',
      recoverable: true,
      retryable: true
    } as never)
    try {
      const { rerender } = render(<SourceCard {...makeProps({ recording: deviceOnly, deviceConnected: true, onDownload })} />)
      expect(screen.getByTestId('card-notice')).toHaveTextContent('The dock stopped sending')
      fireEvent.click(screen.getByRole('button', { name: 'Retry download' }))
      expect(onDownload).toHaveBeenCalledTimes(1)
      useLibraryStore.getState().clearRecordingError('r1')
      rerender(<SourceCard {...makeProps({ recording: deviceOnly, deviceConnected: false, onDownload })} />)
      const download = screen.getByRole('button', { name: 'Download to computer' })
      expect(download).toHaveTextContent('Download')
      expect(download).toBeDisabled()
    } finally {
      useLibraryStore.getState().clearRecordingError('r1')
    }
  })

  it('follows the local file: a recording that gets its file can be played and transcribed without a new id', () => {
    const onTranscribe = vi.fn()
    const withoutFile = { ...baseRecording, location: 'local-only', localPath: '', transcriptionStatus: 'none' } as UnifiedRecording
    const { rerender } = render(<SourceCard {...makeProps({ recording: withoutFile, onTranscribe })} />)
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Transcribe' })).toBeNull()
    rerender(
      <SourceCard
        {...makeProps({ recording: { ...withoutFile, localPath: '/data/meeting.wav' } as UnifiedRecording, onTranscribe })}
      />
    )
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Transcribe' })).toBeInTheDocument()
  })

  it('keeps the same five blocks as before: the added information takes no extra line', () => {
    render(<SourceCard {...makeProps({ transcript: analysed, meeting: { id: 'm1', subject: 'Weekly', attendees: null } as unknown as Meeting })} />)
    // title, date and counts, chips and people, body, footer
    expect(screen.getByTestId('source-card').children).toHaveLength(5)
  })

  it('puts the meeting in the footer, where the empty space is, and the state icons and actions around it', () => {
    render(
      <SourceCard
        {...makeProps({
          transcript: analysed,
          meeting: { id: 'm1', subject: 'Weekly', attendees: null } as unknown as Meeting,
          recording: { ...baseRecording, transcriptionStatus: 'none' },
          onTranscribe: vi.fn()
        })}
      />
    )
    const footer = screen.getByTestId('card-status').parentElement!
    expect(footer.contains(screen.getByTestId('card-meeting'))).toBe(true)
    expect(footer.contains(screen.getByTestId('card-action'))).toBe(true)
    expect(footer.contains(screen.getByRole('button', { name: 'Play' }))).toBe(true)
  })
})


it.each(['invalid', 'incomplete', 'doubtful'] as const)('hides stale card evaluation while %s and restores it after acceptance', (validity_status) => {
  const recording = { ...baseRecording, evalStarLevel: 5 as const, evalKind: 'team_meeting' as const }
  const transcript = { integrity_status: 'ok', validity_status, integrity_accepted_at: null } as Transcript
  const { rerender } = render(<SourceCard {...makeProps({ recording, transcript })} />)
  expect(screen.getByTestId('validity-label')).toBeInTheDocument()
  expect(screen.queryByTestId('evaluation-label')).toBeNull()
  rerender(<SourceCard {...makeProps({ recording, transcript: { ...transcript, validity_status: 'valid', integrity_accepted_at: '2026-10-04' } })} />)
  expect(screen.queryByTestId('validity-label')).toBeNull()
  expect(screen.getByTestId('evaluation-label')).toHaveTextContent('Team meeting')
})
