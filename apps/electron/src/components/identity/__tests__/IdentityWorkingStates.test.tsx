import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MergeIntoDialog } from '../MergeIntoDialog'
import { ResolvePerMeetingCard } from '../ResolvePerMeetingCard'
import type { BucketResolution } from '../useAmbiguousBuckets'

// Loading states are placeholders with the words in their name, never text (owner, 2-oct-2026).

const getAll = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  global.window.electronAPI = { contacts: { getAll } } as never
})

describe('MergeIntoDialog while the people load', () => {
  it('shows placeholder rows, never the old word', async () => {
    let finish: (v: unknown) => void = () => {}
    getAll.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<MergeIntoDialog open onOpenChange={vi.fn()} loserName="Sebas" excludeIds={[]} onPick={vi.fn()} />)
    expect(await screen.findByRole('status', { name: 'Loading people' })).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    finish({ success: true, data: { contacts: [{ id: 'c1', name: 'Sebastian Geraldes' }] } })
    expect(await screen.findByText('Sebastian Geraldes')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading people' })).not.toBeInTheDocument()
  })
})

describe('ResolvePerMeetingCard while the recordings load', () => {
  it('shows placeholder rows, never the old sentence', async () => {
    let finish: (v: BucketResolution | null) => void = () => {}
    const fetchResolution = vi.fn(() => new Promise<BucketResolution | null>((resolve) => { finish = resolve }))
    render(
      <ResolvePerMeetingCard
        bucket={{ contactId: 'b1', name: 'Sergio', candidates: [{ id: 'c1', name: 'Sergio Reyes' }], recordingCount: 1, resolvedCount: 0, pendingCount: 1 }}
        fetchResolution={fetchResolution}
        resolve={vi.fn(async () => true)}
        onOpenRecording={vi.fn()}
        onResolved={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(await screen.findByRole('status', { name: 'Loading recordings' })).toBeInTheDocument()
    expect(screen.queryByText(/Loading recordings/)).not.toBeInTheDocument()
    finish({ contactId: 'b1', name: 'Sergio', candidates: [], recordings: [] })
    expect(await screen.findByText('No linked recordings to resolve.')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading recordings' })).not.toBeInTheDocument()
  })
})
