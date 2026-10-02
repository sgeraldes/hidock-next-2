import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { HealthCheck } from '../HealthCheck'

vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector: (s: unknown) => unknown) => selector({ invalidateUnifiedRecordings: vi.fn() }))
}))

const runScan = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  global.window.electronAPI = { integrity: { runScan } } as never
})

describe('HealthCheck while it scans', () => {
  // A busy button keeps its label and spins; the state goes to the tooltip (owner, 2-oct-2026).
  it('keeps the Run Health Check label, spins and says Scanning only in its tooltip', async () => {
    let finish: (v: unknown) => void = () => {}
    runScan.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<HealthCheck />)
    fireEvent.click(screen.getByRole('button', { name: 'Run Health Check' }))
    const button = screen.getByRole('button', { name: 'Run Health Check' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('title', 'Scanning')
    expect(screen.queryByText('Scanning...')).not.toBeInTheDocument()
    finish({
      scanStarted: '', scanCompleted: '', totalIssues: 0, issuesByType: {}, issuesBySeverity: {}, issues: [], autoRepairableCount: 0
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run Health Check' })).not.toHaveAttribute('aria-busy'))
  })
})
