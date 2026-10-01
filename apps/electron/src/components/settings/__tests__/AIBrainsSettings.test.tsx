import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AIBrainsSettings } from '../AIBrainsSettings'

// Silence the toaster (only used on error paths here).
vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const mockList = vi.fn()
const mockSetEnabled = vi.fn()
const mockSetDefault = vi.fn()
const mockGetConnection = vi.fn()
const mockSetConnection = vi.fn()

/** Two brains: one configured (Gemini, default) + one unconfigured (Claude Code). */
const BRAINS = [
  {
    id: 'gemini-api',
    label: 'Gemini (API key)',
    capabilities: ['generate', 'chat', 'embed', 'analyzeAudio'],
    enabled: true,
    isDefault: true,
    auth: { configured: true, method: 'api-key', detail: 'Key set' },
  },
  {
    id: 'claude-code',
    label: 'Claude Code SDK',
    capabilities: ['generate', 'chat', 'agentic'],
    enabled: false,
    isDefault: false,
    auth: { configured: false, method: 'cli-login', detail: 'Needs login' },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue(BRAINS)
  mockSetEnabled.mockResolvedValue({ success: true })
  mockSetDefault.mockResolvedValue({ success: true })
  mockGetConnection.mockResolvedValue({ baseUrl: 'http://localhost:1234/v1', model: '', embeddingModel: '', hasKey: false })
  mockSetConnection.mockResolvedValue({ success: true })
  global.window.electronAPI = {
    brains: {
      list: mockList,
      setEnabled: mockSetEnabled,
      setDefault: mockSetDefault,
      getOpenAiCompatible: mockGetConnection,
      setOpenAiCompatible: mockSetConnection,
    },
  } as any
})

describe('AIBrainsSettings', () => {
  it('renders the card title and explainer', async () => {
    render(<AIBrainsSettings />)
    expect(screen.getByText('AI Brains')).toBeInTheDocument()
    expect(
      screen.getByText(/Choose which AI provider powers analysis, chat, and outputs/i)
    ).toBeInTheDocument()
    await screen.findByText('Gemini (API key)')
  })

  it('renders every brain from the registry, data-driven (not hardcoded)', async () => {
    render(<AIBrainsSettings />)
    expect(await screen.findByText('Gemini (API key)')).toBeInTheDocument()
    expect(screen.getByText('Claude Code SDK')).toBeInTheDocument()
    // Capability chips.
    expect(screen.getAllByText('Generate').length).toBe(2)
    expect(screen.getByText('Audio')).toBeInTheDocument()
    expect(screen.getByText('Agentic')).toBeInTheDocument()
  })

  it('shows a configured (green) and an unconfigured auth badge', async () => {
    render(<AIBrainsSettings />)
    expect(await screen.findByText('Key set')).toBeInTheDocument()
    expect(screen.getByText('Needs login')).toBeInTheDocument()
  })

  it('renders an enable toggle + default radio for each brain', async () => {
    render(<AIBrainsSettings />)
    await screen.findByText('Gemini (API key)')
    // Switch (role=switch) per brain.
    expect(screen.getByLabelText('Enable Gemini (API key)')).toBeInTheDocument()
    expect(screen.getByLabelText('Enable Claude Code SDK')).toBeInTheDocument()
    // Default radios per brain.
    expect(screen.getByLabelText('Set Gemini (API key) as default brain')).toBeInTheDocument()
    expect(screen.getByLabelText('Set Claude Code SDK as default brain')).toBeInTheDocument()
  })

  it('toggling a brain calls setEnabled with the new value', async () => {
    render(<AIBrainsSettings />)
    const toggle = await screen.findByLabelText('Enable Claude Code SDK')
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(mockSetEnabled).toHaveBeenCalledWith({ id: 'claude-code', enabled: true })
    )
  })

  it('shows the local server card only when the registry has that brain', async () => {
    render(<AIBrainsSettings />)
    await screen.findByText('Gemini (API key)')
    expect(screen.queryByRole('region', { name: 'Local server (OpenAI-compatible)' })).not.toBeInTheDocument()
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('shows the local server card, and reloads the brains after it saves, when the registry has that brain', async () => {
    const local = {
      id: 'openai-compatible',
      label: 'Local server (OpenAI-compatible)',
      capabilities: ['generate', 'chat', 'embed'],
      enabled: true,
      isDefault: false,
      auth: { configured: false, method: 'none', detail: 'Not reachable' },
    }
    mockList.mockResolvedValue([...BRAINS, local])
    render(<AIBrainsSettings />)
    const card = await screen.findByRole('region', { name: 'Local server (OpenAI-compatible)' })
    expect(card).toBeInTheDocument()
    const callsBefore = mockList.mock.calls.length
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'qwen3-8b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => expect(mockSetConnection).toHaveBeenCalled())
    await waitFor(() => expect(mockList.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('renders the empty state when the registry is empty', async () => {
    mockList.mockResolvedValue([])
    render(<AIBrainsSettings />)
    expect(await screen.findByText('No AI brains available.')).toBeInTheDocument()
  })
})
