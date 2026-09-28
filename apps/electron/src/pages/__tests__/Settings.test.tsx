
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { Settings } from '../Settings'

const mockLoadConfig = vi.fn()
const mockUpdateConfig = vi.fn()
const mockSyncCalendar = vi.fn()

// Mock the stores
vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector) => {
    const state = {
      syncCalendar: mockSyncCalendar,
      calendarSyncing: false
    }
    if (typeof selector === 'function') return selector(state)
    return state
  }),
  useCalendarSyncing: vi.fn(() => false),
  // F15: the "Sync Now" control gates on the user's own request, not on any
  // sync — a startup mount sync must not disable it.
  useCalendarManualSyncing: vi.fn(() => false)
}))

vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: vi.fn((selector?: any) => {
    const state = {
      config: {
        calendar: {
          icsUrl: 'https://example.com/cal.ics',
          syncEnabled: true,
          syncIntervalMinutes: 15,
          lastSyncAt: '2026-03-01T10:00:00Z'
        },
        transcription: { geminiApiKey: 'AIzaTestKey12345', geminiModel: 'gemini-3-pro-preview' },
        chat: { provider: 'gemini' as const },
        embeddings: { ollamaBaseUrl: 'http://localhost:11434' }
      },
      loadConfig: mockLoadConfig,
      updateConfig: mockUpdateConfig,
      configLoading: false
    }
    if (typeof selector === 'function') return selector(state)
    return state
  })
}))

// Mock HealthCheck component
vi.mock('@/components/HealthCheck', () => ({
  HealthCheck: () => <div data-testid="health-check">Health Check</div>
}))

// Mock Electron API
global.window.electronAPI = {
  config: {
    get: vi.fn().mockResolvedValue({
      success: true,
      data: {
        calendar: { icsUrl: '', syncEnabled: true, syncIntervalMinutes: 15 },
        transcription: { geminiApiKey: '', geminiModel: 'gemini-3-pro-preview' },
        chat: { provider: 'gemini' },
        embeddings: { ollamaBaseUrl: 'http://localhost:11434' }
      }
    }),
    updateSection: vi.fn().mockResolvedValue({ success: true }),
    listGeminiModels: vi.fn().mockResolvedValue({ success: true, data: { ok: false, models: [] } }),
    checkSpeakerModelAccess: vi.fn().mockResolvedValue({
      success: true,
      data: {
        status: 'token-missing',
        model: 'pyannote/speaker-diarization-community-1',
        fallbackModel: 'pyannote/speaker-diarization-3.1',
        message: 'Add and save a Hugging Face token.'
      }
    }),
    openSpeakerModelAccess: vi.fn().mockResolvedValue({ success: true, data: { opened: true } })
  },
  storage: {
    getInfo: vi.fn().mockResolvedValue({
      success: true,
      data: {
        dataPath: '/data',
        recordingsPath: '/recordings',
        transcriptsPath: '/transcripts',
        cachePath: '/cache',
        databasePath: '/db',
        totalSizeBytes: 1024000,
        recordingsCount: 5
      }
    }),
    openFolder: vi.fn()
  }
} as any

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Settings Page', () => {
  it('should render settings sections', async () => {
    render(<Settings />)

    expect(screen.getByText('Calendar')).toBeInTheDocument()
    expect(screen.getByText('Transcription')).toBeInTheDocument()
    expect(screen.getByText('Chat / RAG')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
  })

  it('should render calendar settings form', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('ICS Calendar URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Enable auto-sync')).toBeInTheDocument()
    expect(screen.getByLabelText('Sync interval in minutes')).toBeInTheDocument()
  })

  it('should render transcription settings form', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('Gemini API Key')).toBeInTheDocument()
    expect(screen.getByLabelText('Transcription Model')).toBeInTheDocument()
    expect(screen.getByLabelText('Hugging Face token for speaker identification')).toBeInTheDocument()
    expect(screen.getByText('Speaker identification model')).toBeInTheDocument()
  })

  it('opens and rechecks Community-1 access from the transcription settings', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: 'Review model access' }))
    expect(window.electronAPI.config.openSpeakerModelAccess).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(window.electronAPI.config.checkSpeakerModelAccess).toHaveBeenCalledWith('')
  })

  it('should render chat provider toggle buttons', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('Use Gemini chat provider')).toBeInTheDocument()
    expect(screen.getByLabelText('Use Ollama local chat provider')).toBeInTheDocument()
  })

  it('should render save buttons for each section', async () => {
    render(<Settings />)

    const saveButtons = screen.getAllByLabelText(/Save.*settings/)
    expect(saveButtons.length).toBe(3) // Calendar, Transcription, Chat
  })

  it('should render storage section', async () => {
    render(<Settings />)

    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText('Local data storage information')).toBeInTheDocument()
  })

  it('should render health check component', async () => {
    render(<Settings />)

    expect(screen.getByTestId('health-check')).toBeInTheDocument()
  })

  // C-006: API key visibility toggle
  it('should toggle API key visibility', async () => {
    render(<Settings />)

    const apiKeyInput = screen.getByLabelText('Gemini API Key') as HTMLInputElement

    // Default: password type
    expect(apiKeyInput.type).toBe('password')

    // Click show API key button
    const toggleButton = screen.getByLabelText('Show API key')
    fireEvent.click(toggleButton)

    // Should now be visible
    expect(apiKeyInput.type).toBe('text')

    // Click hide API key button
    const hideButton = screen.getByLabelText('Hide API key')
    fireEvent.click(hideButton)

    // Should be hidden again
    expect(apiKeyInput.type).toBe('password')
  })

  // C-006: Sync interval clamping - HTML attributes enforce valid range
  it('should render sync interval input with min/max attributes', async () => {
    render(<Settings />)

    const intervalInput = screen.getByLabelText('Sync interval in minutes') as HTMLInputElement

    // Should initialize with the config value
    expect(intervalInput.value).toBe('15')

    // Verify the input has proper min/max attributes for HTML validation
    expect(intervalInput.min).toBe('5')
    expect(intervalInput.max).toBe('120')

    // Verify input type is number
    expect(intervalInput.type).toBe('number')
  })

  // C-006: Checkbox has no redundant onKeyDown (verified by inspection; test native behavior)
  it('should render sync checkbox with onChange handler', async () => {
    render(<Settings />)

    const checkbox = screen.getByLabelText('Enable auto-sync') as HTMLInputElement

    // Default from mock config
    expect(checkbox.checked).toBe(true)

    // The checkbox should be a controlled component with only onChange,
    // not a redundant onKeyDown handler
    expect(checkbox).toBeInTheDocument()
    expect(checkbox.type).toBe('checkbox')
  })

  // C-006: Last sync time display
  it('should display last sync time when available', async () => {
    render(<Settings />)

    // The mock config has lastSyncAt set to '2026-03-01T10:00:00Z'
    expect(screen.getByText(/Last synced:/)).toBeInTheDocument()
  })

  // Chat Placement control — persists to useUIStore and is honored on load.
  it('should render the Assistant chat-placement control', async () => {
    render(<Settings />)

    expect(screen.getByRole('group', { name: /Chat placement/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Floating' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Embedded' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /Chat position/i })).toBeInTheDocument()
  })

  it('should persist chat placement + position to the UI store', async () => {
    const { useUIStore } = await import('@/store/ui/useUIStore')
    useUIStore.getState().setChatPlacement('floating')
    useUIStore.getState().setChatPosition('right')

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: 'Embedded' }))
    expect(useUIStore.getState().chatPlacement).toBe('embedded')

    fireEvent.click(screen.getByRole('button', { name: 'Left' }))
    expect(useUIStore.getState().chatPosition).toBe('left')

    // The pressed state reflects the selection (honored on subsequent render).
    expect(screen.getByRole('button', { name: 'Embedded' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true')
  })

  // S-1 (Phase-1 integration review) — the valueClassificationEnabled
  // kill-switch gates only the live path; the Settings-triggered backfill
  // ignores it by design, so the card shows a one-line hint when it's off.
  it('shows a kill-switch hint on the value-classification card when valueClassificationEnabled is false', async () => {
    const { useConfigStore } = await import('@/store/domain/useConfigStore')
    const mockedUseConfigStore = vi.mocked(useConfigStore)
    // Settings re-renders (e.g. once loadStorageInfo's promise resolves), so
    // useConfigStore is called more than once during this test — a persistent
    // mockImplementation (not ...Once) is needed for every render to see the
    // override; restored in `finally` so it never leaks into later tests.
    const originalImpl = mockedUseConfigStore.getMockImplementation()
    mockedUseConfigStore.mockImplementation((selector?: any) => {
      const state = {
        config: {
          calendar: {
            icsUrl: 'https://example.com/cal.ics',
            syncEnabled: true,
            syncIntervalMinutes: 15,
            lastSyncAt: '2026-03-01T10:00:00Z'
          },
          transcription: {
            geminiApiKey: 'AIzaTestKey12345',
            geminiModel: 'gemini-3-pro-preview',
            valueClassificationEnabled: false
          },
          chat: { provider: 'gemini' as const },
          embeddings: { ollamaBaseUrl: 'http://localhost:11434' }
        },
        loadConfig: mockLoadConfig,
        updateConfig: mockUpdateConfig,
        configLoading: false
      }
      if (typeof selector === 'function') return selector(state)
      return state
    })

    try {
      render(<Settings />)
      expect(screen.getByText(/Automatic rating of newly transcribed recordings is turned off/)).toBeInTheDocument()
    } finally {
      if (originalImpl) mockedUseConfigStore.mockImplementation(originalImpl)
    }
  })

  it('hides the kill-switch hint when valueClassificationEnabled is not explicitly false', async () => {
    render(<Settings />)
    expect(screen.queryByText(/Automatic rating of newly transcribed recordings is turned off/)).not.toBeInTheDocument()
  })

  it('removes a saved Jev key from the same field', async () => {
    const { useConfigStore } = await import('@/store/domain/useConfigStore')
    const mockedUseConfigStore = vi.mocked(useConfigStore)
    const originalImpl = mockedUseConfigStore.getMockImplementation()
    mockedUseConfigStore.mockImplementation((selector?: any) => {
      const state = {
        config: {
          calendar: { icsUrl: '', syncEnabled: false, syncIntervalMinutes: 15, lastSyncAt: null },
          transcription: { geminiApiKey: '', geminiModel: 'gemini-3-pro-preview', jevApiKey: 'saved' }, // pragma: allowlist secret
          chat: { provider: 'gemini' as const },
          embeddings: { ollamaBaseUrl: 'http://localhost:11434' }
        },
        loadConfig: mockLoadConfig,
        updateConfig: mockUpdateConfig,
        configLoading: false
      }
      if (typeof selector === 'function') return selector(state)
      return state
    })
    mockUpdateConfig.mockResolvedValue(undefined)

    try {
      render(<Settings />)
      // The saved key is never shown; the field offers to replace it.
      const input = screen.getByLabelText('Jev API key (TypeSafe AI)') as HTMLInputElement
      expect(input.value).toBe('')
      expect(screen.getByText(/Jev rates recordings/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Remove key' }))
      await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalledWith('transcription', { jevApiKey: '' }))
    } finally {
      if (originalImpl) mockedUseConfigStore.mockImplementation(originalImpl)
    }
  })

  it('saves a pasted Jev key through updateConfig and never shows it back', async () => {
    mockUpdateConfig.mockResolvedValue(undefined)
    render(<Settings />)

    const input = screen.getByLabelText('Jev API key (TypeSafe AI)') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: '  ts-test-key  ' } }) // pragma: allowlist secret
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))

    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalledWith('transcription', { jevApiKey: 'ts-test-key' })) // pragma: allowlist secret
    // The draft clears after saving; the saved key lives only in config.
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('shows one section at a time with the settings menu', () => {
    const onSectionChange = vi.fn()
    render(<Settings section="calendar" onSectionChange={onSectionChange} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Calendar' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument()
    // Only the Calendar page: other pages' controls are not rendered.
    expect(screen.getByLabelText(/ICS/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Provider in use')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Transcription' }))
    expect(onSectionChange).toHaveBeenCalledWith('transcription')
  })

  it('searches the menu and opens the first match on Enter', () => {
    const onSectionChange = vi.fn()
    render(<Settings section="overview" onSectionChange={onSectionChange} />)
    const search = screen.getByRole('searchbox', { name: 'Search settings' })
    fireEvent.change(search, { target: { value: 'hugging' } })
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Speakers & voices'])
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSectionChange).toHaveBeenCalledWith('speakers')
  })

  it('opens the page behind an overview tile', () => {
    const onSectionChange = vi.fn()
    render(<Settings section="overview" onSectionChange={onSectionChange} />)
    fireEvent.click(within(screen.getByTestId('settings-overview')).getByText('Decisions (Jev)'))
    expect(onSectionChange).toHaveBeenCalledWith('decisions')
  })

  it('picks the transcription provider from a list and keeps every provider configurable', () => {
    render(<Settings />)
    const provider = screen.getByLabelText('Provider in use') as HTMLSelectElement
    expect(provider.tagName).toBe('SELECT')
    expect(Array.from(provider.options).map((o) => o.value)).toEqual(['gemini', 'local-asr', 'vibevoice'])

    // Both providers' settings show whichever one is in use.
    expect(screen.getByLabelText('Gemini API Key')).toBeInTheDocument()
    expect(screen.getByLabelText('ASR MCP project path')).toBeInTheDocument()
    fireEvent.change(provider, { target: { value: 'local-asr' } })
    expect(screen.getByLabelText('Gemini API Key')).toBeInTheDocument()
    expect(screen.getByLabelText('ASR MCP project path')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Local ASR and VibeVoice/ })).toHaveTextContent('In use')
    expect(screen.getByRole('heading', { name: /^Gemini/ })).not.toHaveTextContent('In use')
  })

  it('shows the speaker identification model in Speakers and voices, not under the provider', () => {
    render(<Settings />)
    const speakers = screen.getByTestId('speakers-and-voices')
    expect(speakers).toContainElement(screen.getByRole('heading', { name: 'Speaker identification model' }))
  })

  it('saves a changed Hugging Face token on its own, without the Transcription Save button', async () => {
    mockUpdateConfig.mockResolvedValue(undefined)
    render(<Settings />)

    const save = screen.getByTestId('save-speaker-token')
    expect(save).toBeDisabled() // nothing changed yet
    fireEvent.change(screen.getByLabelText('Hugging Face token for speaker identification'), {
      target: { value: ' hf_newtoken ' } // pragma: allowlist secret
    })
    expect(save).toHaveTextContent('Save token')
    fireEvent.click(save)

    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith('transcription', { localAsrHfToken: 'hf_newtoken' }) // pragma: allowlist secret
    )
  })

  /**
   * F15 / re-review #3: the startup mount sync parks on the boot gate for the
   * whole startup window. Gating this control on "any sync in flight" disabled
   * it during exactly the period the bounded manual path exists to serve.
   */
  describe('Sync Now availability during a startup sync', () => {
    it('stays enabled while only a background/mount sync is in flight', async () => {
      const { useCalendarSyncing, useCalendarManualSyncing } = await import('@/store/useAppStore')
      vi.mocked(useCalendarSyncing).mockReturnValue(true) // something IS syncing
      vi.mocked(useCalendarManualSyncing).mockReturnValue(false) // but not the user's

      render(<Settings />)

      const button = screen.getByRole('button', { name: 'Sync calendar now' })
      expect(button).not.toBeDisabled()

      // And clicking it reaches the manual path.
      fireEvent.click(button)
      expect(mockSyncCalendar).toHaveBeenCalledWith('manual')
    })

    it('is disabled while the user’s own request is outstanding', async () => {
      const { useCalendarManualSyncing } = await import('@/store/useAppStore')
      vi.mocked(useCalendarManualSyncing).mockReturnValue(true)

      render(<Settings />)

      expect(screen.getByRole('button', { name: 'Sync calendar now' })).toBeDisabled()
    })
  })
})
