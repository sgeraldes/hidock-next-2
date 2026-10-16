import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ModelHostSettings } from '../ModelHostSettings'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { toast } from '@/components/ui/toaster'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const pair = vi.fn()
const setStepAside = vi.fn()
const status = vi.fn()
const prepareAsr = vi.fn()
const prepareRole = vi.fn()
const check = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  pair.mockResolvedValue({ success: true, setup: { status: 'validating' } })
  prepareRole.mockResolvedValue({ success: true })
  check.mockResolvedValue({ success: false })
  prepareAsr.mockResolvedValue({ success: true })
  setStepAside.mockResolvedValue({ success: true, sent: true })
  status.mockResolvedValue({
    success: true,
    status: { configured: true, paired: true, usedForSpeakers: true, hasHfToken: true, address: 'gamestation:8765', health: null }
  })
  useConfigStore.setState({
    config: { transcription: { modelHostUrl: 'gamestation:8765', modelHostToken: 't', modelHostStepAside: 'games' } } as never
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    modelHost: { pair, setStepAside, status, prepareAsr, prepareRole, check, forget: vi.fn() }
  }
})

describe('ModelHostSettings', () => {
  it('requires an explicit role click, discloses costs and waits for a readiness check', async () => {
    const savedConfig = JSON.stringify(useConfigStore.getState().config)
    render(<ModelHostSettings />)
    expect(prepareRole).not.toHaveBeenCalled()
    expect(screen.getByText(/models\/nemotron-3-embed-1b/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare text generation (about 5.7 GB)' }))
    await screen.findByText(/Preparation accepted/)
    expect(prepareRole).toHaveBeenCalledWith({ role: 'generation' })
    expect(screen.getByRole('button', { name: 'Prepare semantic search' })).toBeDisabled()
    check.mockResolvedValue({ success: true, health: { version: '0.4.8', state: 'ready', capabilities: [], textGeneration: { ready: true } } })
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    await screen.findByText(/Host reconnected and this role is ready/)
    expect(screen.getByRole('button', { name: 'Prepare semantic search' })).not.toBeDisabled()
    expect(JSON.stringify(useConfigStore.getState().config)).toBe(savedConfig)
  })
  it('shows missing semantic assets without claiming readiness', async () => {
    prepareRole.mockResolvedValue({ success: false, error: 'Imported semantic model folder missing' })
    render(<ModelHostSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare semantic search' }))
    expect(await screen.findByText('Imported semantic model folder missing')).toHaveAttribute('role', 'status')
    expect(prepareRole).toHaveBeenCalledWith({ role: 'semantic' })
  })

  it('prepares an explicit remote engine and announces reconnect without changing the default service', async () => {
    render(<ModelHostSettings />)
    fireEvent.change(screen.getByLabelText('Prepare transcription on this host'), { target: { value: 'microsoft/VibeVoice-ASR' } })
    fireEvent.click(screen.getByRole('button', { name: 'Prepare engine' }))
    await waitFor(() => expect(prepareAsr).toHaveBeenCalledWith({ model: 'microsoft/VibeVoice-ASR' }))
    expect(await screen.findByText(/Preparation started on the host/)).toHaveAttribute('role', 'status')
  })
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
