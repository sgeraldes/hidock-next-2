import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { CONFIG_SECRETS, SecretsSection } from '../SecretsSection'
import { SAVED_SECRET, SECRET_CONFIG_FIELDS } from '@/shared/secret-fields'
import { useConfigStore } from '@/store/domain/useConfigStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const updateConfig = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({
    config: { transcription: { geminiApiKey: SAVED_SECRET, localAsrHfToken: '' }, calendar: { icsUrl: SAVED_SECRET } } as never,
    updateConfig
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    brains: { list: vi.fn(async () => [{ label: 'Anthropic', auth: { configured: true, method: 'api-key' } }]) },
    connectors: { list: vi.fn(async () => [{ label: 'Slack', fields: [{ label: 'Bot token', secret: true, hasValue: false }] }]) }
  }
})

describe('Settings > Secrets', () => {
  it('lists every secret the config keeps, and only those', () => {
    expect(CONFIG_SECRETS.map((s) => [s.section, s.key])).toEqual(SECRET_CONFIG_FIELDS.map(([a, b]) => [a, b]))
  })

  it('shows set or not set, never a value', async () => {
    render(<SecretsSection />)
    expect(screen.getByTestId('secret-geminiApiKey')).toHaveTextContent('Set')
    expect(screen.getByTestId('secret-localAsrHfToken')).toHaveTextContent('Not set')
    expect(screen.queryByText(SAVED_SECRET)).toBeNull()
    expect(await screen.findByText('Anthropic (AI provider)')).toBeInTheDocument()
    expect(screen.getByText('Slack: Bot token')).toBeInTheDocument()
  })

  it('replaces a key, and removes one only after confirming', async () => {
    render(<SecretsSection />)
    const gemini = screen.getByTestId('secret-geminiApiKey')
    fireEvent.click(gemini.querySelector('button')!)
    fireEvent.change(screen.getByLabelText('New google gemini api key'), { target: { value: ' AIzaNEW ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('transcription', { geminiApiKey: 'AIzaNEW' })) // pragma: allowlist secret

    fireEvent.click(screen.getByTestId('secret-icsUrl').querySelectorAll('button')[1])
    expect(updateConfig).toHaveBeenCalledTimes(1)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('calendar', { icsUrl: '' }))
  })
})
