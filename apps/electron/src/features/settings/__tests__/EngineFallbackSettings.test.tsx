import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EngineFallbackSettings } from '../EngineFallbackSettings'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { DEFAULT_ENGINE_CHAIN_ENTRIES } from '@/shared/transcription-engines'

const availability = vi.fn()
// Saves into the store like the real one, so the next click sees the new order.
const update = vi.fn(async (_section: string, values: Record<string, unknown>) => {
  const transcription = useConfigStore.getState().config?.transcription ?? {}
  useConfigStore.setState({ config: { transcription: { ...transcription, ...values } } as never })
})

function setTranscription(transcription: Record<string, unknown>) {
  useConfigStore.setState({ config: { transcription } as never, updateConfig: update })
}

beforeEach(() => {
  availability.mockReset()
  update.mockClear()
  window.electronAPI = { recordings: { getTranscriptionEngineAvailability: availability } } as never
  availability.mockResolvedValue([
    { entry: 'configured', label: 'Default service (Pipeline)', unavailableReason: null },
    { entry: 'remote:moondream/parakeet-ultra', label: 'x', unavailableReason: 'The Model Host is paused: a game is running' },
    { entry: 'remote:Qwen/Qwen3-ASR-1.7B', label: 'x', unavailableReason: null },
  ])
  setTranscription({ provider: 'gemini' })
})

describe('Settings: when transcription fails', () => {
  it('shows the measured order with what can run now', async () => {
    render(<EngineFallbackSettings />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(DEFAULT_ENGINE_CHAIN_ENTRIES.length)
    expect(rows[0]).toHaveTextContent('Default service (Pipeline)')
    expect(rows[1]).toHaveTextContent('Parakeet Ultra')
    await waitFor(() => expect(rows[1]).toHaveTextContent('Unavailable now: The Model Host is paused: a game is running'))
    expect(rows[2]).toHaveTextContent('Available')
  })

  it('moves, removes and adds engines by saving the whole order', async () => {
    render(<EngineFallbackSettings />)
    const enabled = (name: RegExp | string) => waitFor(() => expect(screen.getByRole('button', { name })).not.toBeDisabled())
    await enabled(/Move Qwen3-ASR 1.7B .* up/)
    fireEvent.click(screen.getByRole('button', { name: /Move Qwen3-ASR 1.7B .* up/ }))
    expect(update).toHaveBeenLastCalledWith('transcription', {
      engineChain: ['configured', 'remote:Qwen/Qwen3-ASR-1.7B', 'remote:moondream/parakeet-ultra'],
    })
    await enabled(/Remove Parakeet Ultra/)
    fireEvent.click(screen.getByRole('button', { name: /Remove Parakeet Ultra/ }))
    expect(update).toHaveBeenLastCalledWith('transcription', { engineChain: ['configured', 'remote:Qwen/Qwen3-ASR-1.7B'] })

    await waitFor(() => expect(screen.getByLabelText('Engine to add')).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('Engine to add'), { target: { value: 'gemini' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('transcription', {
      engineChain: ['configured', 'remote:Qwen/Qwen3-ASR-1.7B', 'gemini'],
    }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('names the add-engine picker without a visually hidden label (23-oct overscroll bug)', () => {
    // An sr-only label is position:absolute; with no positioned ancestor in the
    // settings scroller it escaped the scroller and made the whole window scroll.
    const { container } = render(<EngineFallbackSettings />)
    expect(screen.getByRole('combobox', { name: 'Engine to add' })).toBeInTheDocument()
    expect(container.querySelector('.sr-only')).toBeNull()
  })

  it('never offers an engine already in the order, and keeps the last one', () => {
    setTranscription({ engineChain: ['gemini'] })
    render(<EngineFallbackSettings />)
    expect(screen.queryByRole('option', { name: 'Gemini · cloud' })).toBeNull()
    expect(screen.getByRole('button', { name: /Remove Gemini/ })).toBeDisabled()
  })

  it('saves the fallback switch, the retries per error and the split switch', async () => {
    render(<EngineFallbackSettings />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Try the next engine when one fails' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('transcription', { engineFallbackEnabled: false }))
    fireEvent.change(screen.getByLabelText(/Retries for Rate limit/), { target: { value: '5' } })
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('transcription', { engineRetries: { transient: 2, quota: 5, unknown: 0 } }))
    fireEvent.click(screen.getByRole('checkbox', { name: /send that piece again in halves/ }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('transcription', { splitIncompleteAudio: false }))
  })
})
