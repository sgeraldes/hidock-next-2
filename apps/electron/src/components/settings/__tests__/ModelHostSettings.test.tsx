import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ModelHostSettings } from '../ModelHostSettings'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { toast } from '@/components/ui/toaster'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const pair = vi.fn()
const setStepAside = vi.fn()
const status = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  pair.mockResolvedValue({ success: true, setup: { status: 'validating' } })
  setStepAside.mockResolvedValue({ success: true, sent: true })
  status.mockResolvedValue({
    success: true,
    status: { configured: true, paired: true, usedForSpeakers: true, hasHfToken: true, address: 'gamestation:8765', health: null }
  })
  useConfigStore.setState({
    config: { transcription: { modelHostUrl: 'gamestation:8765', modelHostToken: 't', modelHostStepAside: 'games' } } as never
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    modelHost: { pair, setStepAside, status, check: vi.fn(), forget: vi.fn() }
  }
})

describe('ModelHostSettings', () => {
  it('pairs with no code, for the host’s automatic pairing', async () => {
    render(<ModelHostSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await waitFor(() => expect(pair).toHaveBeenCalledWith({ url: 'gamestation:8765', code: '' }))
    expect(toast.success).toHaveBeenCalled()
  })

  it('says what the host did not get when pairing worked but provisioning did not', async () => {
    pair.mockResolvedValue({ success: true, warning: 'This computer has no Hugging Face token to give the host.' })
    render(<ModelHostSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Paired, with a problem', expect.stringMatching(/Hugging Face token/)))
  })

  it('offers the one setting for the gamestation, in three positions, and sends a change', async () => {
    render(<ModelHostSettings />)
    const select = screen.getByLabelText('When the gamestation is in use') as HTMLSelectElement
    expect(select.value).toBe('games')
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['any-use', 'games', 'never'])
    fireEvent.change(select, { target: { value: 'any-use' } })
    await waitFor(() => expect(setStepAside).toHaveBeenCalledWith({ value: 'any-use' }))
  })
})
