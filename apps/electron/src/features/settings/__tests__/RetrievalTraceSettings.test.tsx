import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RetrievalTraceSettings } from '../RetrievalTraceSettings'
const updateConfig = vi.fn()
const stats = vi.fn()
vi.mock('@/store/domain/useConfigStore', () => ({ useConfigStore: () => ({ config: { chat: {} }, updateConfig }) }))
beforeEach(() => {
  vi.clearAllMocks()
  updateConfig.mockResolvedValue(undefined)
  stats.mockResolvedValue({ success: true, data: { consumers: { chat: 3, explore: 2, brain: 1 }, dropped_events: 4, file_bytes: 1024 } })
  window.electronAPI = { traces: { stats } } as any
})
describe('Assistant query recording settings', () => {
  it('defaults both switches on and shows the real seven-day counts', async () => {
    render(<RetrievalTraceSettings />)
    expect(screen.getByRole('switch', { name: 'Record queries' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Keep the text of my queries (encrypted, 30 days)' })).toBeChecked()
    expect(await screen.findByText(/Chat 3 · Explore 2 · Brain 1/)).toHaveTextContent('4 dropped')
  })
  it('saves both switches through the existing chat config section', async () => {
    render(<RetrievalTraceSettings />)
    fireEvent.click(screen.getByRole('switch', { name: 'Record queries' }))
    expect(updateConfig).toHaveBeenCalledWith('chat', { recordQueries: false })
    await screen.findByText(/Chat 3/)
    fireEvent.click(screen.getByRole('switch', { name: 'Keep the text of my queries (encrypted, 30 days)' }))
    expect(updateConfig).toHaveBeenCalledWith('chat', { keepQueryText: false })
  })
  it('shows an unavailable state instead of inventing zero counts', async () => {
    stats.mockRejectedValue(new Error('disk unavailable'))
    render(<RetrievalTraceSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Query recording statistics could not be read')
  })
})
