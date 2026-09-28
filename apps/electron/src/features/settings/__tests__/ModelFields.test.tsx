import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DiarizationCpuShare, OllamaModelFields } from '../ModelFields'
import { useConfigStore } from '@/store/domain/useConfigStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))
const updateConfig = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  updateConfig.mockClear()
  useConfigStore.setState({
    config: { chat: { ollamaModel: 'llama3.2' }, embeddings: { ollamaModel: 'nomic-embed-text' }, transcription: {} } as never,
    updateConfig
  })
})

describe('model fields', () => {
  it('saves the Ollama chat and embedding models to their own sections', () => {
    render(<OllamaModelFields />)
    const chat = screen.getByLabelText('Ollama chat model')
    fireEvent.change(chat, { target: { value: 'qwen3:8b' } })
    fireEvent.blur(chat)
    expect(updateConfig).toHaveBeenCalledWith('chat', { ollamaModel: 'qwen3:8b' })
    const embed = screen.getByLabelText('Ollama embedding model')
    fireEvent.change(embed, { target: { value: '  ' } })
    fireEvent.blur(embed)
    expect(updateConfig).toHaveBeenCalledTimes(1)
  })

  it('saves the speaker CPU share, 40% by default', () => {
    render(<DiarizationCpuShare />)
    const select = screen.getByLabelText('CPU share for speaker identification') as HTMLSelectElement
    expect(select.value).toBe('40')
    fireEvent.change(select, { target: { value: '25' } })
    expect(updateConfig).toHaveBeenCalledWith('transcription', { speakerLinkingCpuPercent: 25 })
  })
})
