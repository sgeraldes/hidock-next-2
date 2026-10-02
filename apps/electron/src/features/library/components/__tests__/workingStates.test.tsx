/**
 * Work in flight in the Library shows a spinner, a placeholder or a number, never a
 * sentence; the words go to the tooltip and the accessible name (owner, 2-oct-2026).
 * These components had no tests of their own, so their working states live here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DeviceDisconnectBanner } from '../DeviceDisconnectBanner'
import { BulkActionsBar } from '../BulkActionsBar'
import { BulkProgressModal } from '../BulkProgressModal'
import { TranscriptUpgradeButton } from '../TranscriptUpgradeButton'
import { TranscriptionStatusBadge } from '../TranscriptionStatusBadge'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() })
}))

describe('DeviceDisconnectBanner', () => {
  it('reconnecting shows a spinner and a short noun; the sentence goes to the name and tooltip', () => {
    render(<DeviceDisconnectBanner show isReconnecting onNavigateToDevice={vi.fn()} onRetry={vi.fn()} />)
    const status = screen.getByRole('status', { name: 'Reconnecting to device' })
    expect(status).toHaveAttribute('title', 'Reconnecting to device')
    expect(screen.queryByText(/Reconnecting to device/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Please wait while we reconnect/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('disconnected keeps its message: that is a state, not work', () => {
    render(<DeviceDisconnectBanner show isReconnecting={false} onNavigateToDevice={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.getByText('Device disconnected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})

describe('BulkActionsBar', () => {
  const props = {
    selectedCount: 2,
    totalCount: 5,
    deviceConnected: true,
    onSelectAll: vi.fn(),
    onDeselectAll: vi.fn(),
    onDownload: vi.fn(),
    onProcess: vi.fn(),
    onDelete: vi.fn()
  }

  it('while processing, Transcribe keeps its label, is busy and disabled, and the tooltip says Processing', () => {
    render(<BulkActionsBar {...props} isProcessing progress={{ current: 1, total: 2 }} />)
    const button = screen.getByRole('button', { name: 'Transcribe' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('title', 'Processing')
    expect(screen.queryByText('Processing...')).not.toBeInTheDocument()
  })
})

describe('BulkProgressModal', () => {
  it('while running, the close button shows a spinner and the counts, the word goes to the tooltip', () => {
    render(
      <BulkProgressModal
        isOpen
        onClose={vi.fn()}
        onCancel={vi.fn()}
        operation="download"
        progress={{ current: 1, total: 3 }}
        items={[
          { id: 'a', data: { title: 'A' }, status: 'success' },
          { id: 'b', data: { title: 'B' }, status: 'processing' },
          { id: 'c', data: { title: 'C' }, status: 'pending' }
        ]}
      />
    )
    const button = screen.getByRole('button', { name: 'Running, 1 of 3' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('title', 'Running, 1 of 3')
    expect(button).toHaveTextContent('1 / 3')
    expect(screen.queryByText('Running...')).not.toBeInTheDocument()
    // The heading names the operation and stays.
    expect(screen.getByText('Downloading Files')).toBeInTheDocument()
  })
})

describe('TranscriptUpgradeButton', () => {
  let finishScan: (v: unknown) => void
  let run: ReturnType<typeof vi.fn>

  beforeEach(() => {
    finishScan = () => {}
    run = vi.fn(() => new Promise(() => {}))
    Object.defineProperty(window, 'electronAPI', {
      value: {
        transcriptUpgrade: {
          scan: vi.fn(() => new Promise((res) => { finishScan = res })),
          run,
          getRecommended: vi.fn().mockResolvedValue({ success: true, data: [] })
        }
      },
      writable: true,
      configurable: true
    })
  })

  it('while scanning, the four counts shimmer instead of a sentence; while starting, the button keeps its label', async () => {
    render(<TranscriptUpgradeButton />)
    fireEvent.click(screen.getByRole('button', { name: /upgrade transcripts/i }))

    expect(await screen.findByTestId('upgrade-scan-working')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Scanning transcripts: Flat transcripts' })).toBeInTheDocument()
    expect(screen.getAllByRole('status', { name: /^Scanning transcripts:/ })).toHaveLength(4)
    expect(screen.queryByText(/Scanning transcripts/)).not.toBeInTheDocument()

    finishScan({
      success: true,
      data: { totalTranscripts: 10, legacyTotal: 6, toReformat: 4, recommendedRetranscription: 2, alreadyReformatted: 0, threshold: 1 }
    })
    const reformat = await screen.findByRole('button', { name: 'Reformat 4 now' })
    fireEvent.click(reformat)
    await waitFor(() => expect(run).toHaveBeenCalled())
    const starting = screen.getByRole('button', { name: 'Reformat 4 now' })
    expect(starting).toBeDisabled()
    expect(starting).toHaveAttribute('aria-busy', 'true')
    expect(starting).toHaveAttribute('title', 'Starting')
    expect(screen.queryByText('Starting...')).not.toBeInTheDocument()
  })
})

describe('TranscriptionStatusBadge (full size)', () => {
  it('queued shows a pulsing clock with the word in the name and tooltip', () => {
    render(<TranscriptionStatusBadge status="pending" />)
    const badge = screen.getByRole('img', { name: 'Queued' })
    expect(badge).toHaveAttribute('title', 'Queued')
    expect(badge.textContent).toBe('')
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
  })

  it('in progress shows a spinner with the words in the name and tooltip', () => {
    render(<TranscriptionStatusBadge status="processing" />)
    const badge = screen.getByRole('img', { name: 'In Progress' })
    expect(badge).toHaveAttribute('title', 'In Progress')
    expect(screen.queryByText('In Progress')).not.toBeInTheDocument()
  })

  it('results keep their words', () => {
    render(<TranscriptionStatusBadge status="complete" />)
    expect(screen.getByText('Transcribed')).toBeInTheDocument()
  })
})
