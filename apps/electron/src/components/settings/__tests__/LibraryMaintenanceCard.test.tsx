import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LibraryMaintenanceCard } from '../LibraryMaintenanceCard'

const maintenance = {
  recheckWarnings: vi.fn(async () => ({ success: true, data: { changed: 12, evaluated: 2043 } })),
  relinkMeetings: vi.fn(async () => ({
    success: true,
    data: { unlinkedBefore: 925, unlinkedAfter: 700, linked: 225, meetingsSynced: 1200, historyFrom: '2025-05-11', accounts: 1, errors: [] }
  })),
  redrawWaveforms: vi.fn(async () => ({ success: true, data: { total: 2139, drawn: 1953, keptExact: 186, noEnvelope: 0 } })),
  markEvaluationsOutdated: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { maintenance }
})

function renderCard(overrides: Partial<Parameters<typeof LibraryMaintenanceCard>[0]> = {}) {
  const onRescanWithJev = vi.fn(async () => undefined)
  render(<LibraryMaintenanceCard onRescanWithJev={onRescanWithJev} rescanAvailable rescanRunning={false} {...overrides} />)
  return { onRescanWithJev }
}

describe('LibraryMaintenanceCard', () => {
  it('re-checks warnings and says how many changed', async () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Re-check warnings' }))
    await waitFor(() => expect(screen.getByTestId('maintenance-result-warnings')).toHaveTextContent('12 of 2043 warnings changed.'))
  })

  it('relinks and reports linked and still-unlinked recordings', async () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Relink recordings to meetings' }))
    await waitFor(() =>
      expect(screen.getByTestId('maintenance-result-relink')).toHaveTextContent('225 recordings linked. 700 of 925 still have no meeting. 1200 meetings synced.')
    )
  })

  it('redraws waveforms and reports the counts', async () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Redraw waveforms' }))
    await waitFor(() => expect(screen.getByTestId('maintenance-result-waveforms')).toHaveTextContent('1953 drawn, 186 already exact'))
  })

  it('rescans with Jev through the Settings scan, and only when a Jev key is set', async () => {
    const { onRescanWithJev } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Rescan with Jev' }))
    await waitFor(() => expect(onRescanWithJev).toHaveBeenCalledTimes(1))
  })

  it('disables the rescan without a Jev key', () => {
    renderCard({ rescanAvailable: false })
    expect(screen.getByRole('button', { name: 'Rescan with Jev' })).toBeDisabled()
  })

  it('shows a failure in words', async () => {
    maintenance.recheckWarnings.mockResolvedValueOnce({ success: false, error: { message: 'database is locked' } } as never)
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Re-check warnings' }))
    await waitFor(() => expect(screen.getByTestId('maintenance-result-warnings')).toHaveTextContent('Failed: database is locked'))
  })
})
