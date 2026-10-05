import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptionActivity, activityStage } from '../TranscriptionActivity'
import type { TranscriptionItem } from '@/store/features/useTranscriptionStore'

const item: TranscriptionItem = { id: 'q', recordingId: 'r', filename: 'r.webm', status: 'processing', progress: 30, stage: 'voices', retryCount: 0, attempts: 1, priority: 0, startedAt: new Date(Date.now() - 65000) }
describe('shared transcription activity', () => {
  it('projects advanced ledger stages instead of claiming the audio check is running', () => {
    expect(activityStage('graph-sync').label).toBe('Updating knowledge graph')
    expect(activityStage('timeline-analysis').label).toBe('Building timeline')
  })

  it('shows a plain stage, step progress, elapsed time and Stop', () => {
    const stop = vi.fn()
    render(<TranscriptionActivity item={item} onStop={stop} />)
    expect(screen.getByText(/Separating speakers/)).toBeInTheDocument()
    expect(screen.getByText(/step 3 of/)).toBeInTheDocument()
    expect(screen.getByText(/1m 5s elapsed/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(stop).toHaveBeenCalledWith('r')
  })
  it('shows failure without expansion, labelled time and Retry', () => {
    const retry = vi.fn()
    render(<TranscriptionActivity item={{ ...item, status: 'failed', error: 'Audio preflight could not determine recording duration', completedAt: new Date() }} onRetry={retry} />)
    expect(screen.getByText(/audio length could not be read/)).toBeVisible()
    expect(screen.getByText(/Failed /)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledWith('q')
  })
  it('shows real range progress when available', () => {
    render(<TranscriptionActivity item={{ ...item, stage: 'transcribing_part_2_of_3' }} />)
    expect(screen.getByText(/Transcribing part 2 of 3/)).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33')
  })
})
