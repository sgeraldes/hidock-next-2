import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AdvancedSettings } from '../AdvancedSettings'
import { ADVANCED_SETTINGS, parseAdvancedValue } from '../advanced-settings'
import { useConfigStore } from '@/store/domain/useConfigStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))

const updateConfig = vi.fn().mockResolvedValue(undefined)
const defaults = {
  embeddings: { chunkSize: 500, chunkOverlap: 50 },
  chat: { geminiModel: 'gemini-3.8-flash' },
  transcription: {
    vibevoiceModelId: 'microsoft/VibeVoice-ASR', vibevoiceDevice: 'cuda:0', valueClassificationMinConfidence: 0.6,
    speakerLinkingMatchThreshold: 0.72, speakerLinkingMatchMargin: 0.08, speakerLinkingMinSpeechSeconds: 4,
    speakerLinkingTimeoutSeconds: 600, speakerLinkingPythonPath: 'py', speakerLinkingWorkerPath: ''
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({
    config: { ...structuredClone(defaults), embeddings: { chunkSize: 800, chunkOverlap: 50 } } as never,
    updateConfig
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    config: { getDefaults: vi.fn(async () => ({ success: true, data: defaults })) }
  }
})

describe('Developer > Advanced', () => {
  it('lists every advanced value once, each with the default from the main process', async () => {
    render(<AdvancedSettings />)
    expect(await screen.findAllByText(/^Default:/)).toHaveLength(ADVANCED_SETTINGS.length)
    const keys = ADVANCED_SETTINGS.map((s) => `${s.section}.${s.key}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('saves a valid value and refuses one out of range', async () => {
    render(<AdvancedSettings />)
    const threshold = await screen.findByLabelText('Voice match threshold')
    fireEvent.change(threshold, { target: { value: '0.3' } })
    fireEvent.blur(threshold)
    expect(await screen.findByText('At least 0.5')).toBeInTheDocument()
    expect(updateConfig).not.toHaveBeenCalled()
    fireEvent.change(threshold, { target: { value: '0.8' } })
    fireEvent.blur(threshold)
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('transcription', { speakerLinkingMatchThreshold: 0.8 }))
  })

  it('Enter then leaving the field saves once', async () => {
    updateConfig.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 20)))
    render(<AdvancedSettings />)
    const margin = await screen.findByLabelText('Voice match margin')
    fireEvent.change(margin, { target: { value: '0.1' } })
    fireEvent.keyDown(margin, { key: 'Enter' })
    fireEvent.blur(margin)
    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1))
  })

  it('Reset appears only when the value differs from its default, and saves the default', async () => {
    render(<AdvancedSettings />)
    const reset = await screen.findByRole('button', { name: 'Reset Passage size to its default' })
    expect(screen.queryByRole('button', { name: 'Reset Passage overlap to its default' })).toBeNull()
    fireEvent.click(reset)
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('embeddings', { chunkSize: 500 }))
  })
})

describe('parseAdvancedValue', () => {
  const overlap = ADVANCED_SETTINGS.find((s) => s.key === 'chunkOverlap')!
  const worker = ADVANCED_SETTINGS.find((s) => s.key === 'speakerLinkingWorkerPath')!
  const python = ADVANCED_SETTINGS.find((s) => s.key === 'speakerLinkingPythonPath')!

  it('keeps the overlap at most half the passage size, as the main process does', () => {
    expect(parseAdvancedValue(overlap, '300', { chunkSize: 500 })).toEqual({ error: 'At most half the passage size (250). Raise the passage size first.' })
    expect(parseAdvancedValue(overlap, '25.5', { chunkSize: 500 })).toEqual({ error: 'Enter a whole number' })
    expect(parseAdvancedValue(overlap, '250', { chunkSize: 500 })).toEqual({ value: 250 })
  })

  it('reads a comma decimal, and lets only the worker path be empty', () => {
    const margin = ADVANCED_SETTINGS.find((s) => s.key === 'speakerLinkingMatchMargin')!
    expect(parseAdvancedValue(margin, '0,1')).toEqual({ value: 0.1 })
    expect(parseAdvancedValue(worker, '  ')).toEqual({ value: '' })
    expect(parseAdvancedValue(python, '')).toEqual({ error: 'Cannot be empty' })
  })
})
