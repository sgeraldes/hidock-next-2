import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { AudioExecutionSettings, DiarizationCpuShare, OllamaModelFields } from '../ModelFields'
import { useConfigStore } from '@/store/domain/useConfigStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))
const updateConfig = vi.fn().mockResolvedValue(undefined)
const hostStatus = vi.fn()

beforeEach(() => {
  updateConfig.mockClear()
  hostStatus.mockResolvedValue({ success: true, status: { paired: true,
    health: { asrModels: ['Qwen/Qwen3-ASR-0.6B', 'Edge0/Audio8-ASR-Infinite'] } } })
  Object.assign(window, { electronAPI: { modelHost: { status: hostStatus, prepareAsr: vi.fn() } } })
  useConfigStore.setState({
    config: { chat: { ollamaModel: 'llama3.2' }, embeddings: { ollamaModel: 'nomic-embed-text' }, transcription: {} } as never,
    updateConfig
  })
})

describe('model fields', () => {
  it.each(['es', 'auto', ''])('warns and blocks Audio8 route testing for language %s without changing it', language => {
    useConfigStore.setState({ config: { transcription: {
      provider: 'remote-worker', remoteAsrModel: 'Edge0/Audio8-ASR-Infinite', language
    } } as never })
    render(<AudioExecutionSettings provider="remote-worker" />)
    expect(screen.getByRole('alert')).toHaveTextContent('English and Chinese only')
    expect(screen.getByRole('button', { name: 'Test selected route' })).toBeDisabled()
    expect(updateConfig).not.toHaveBeenCalled()
    expect(useConfigStore.getState().config?.transcription.language).toBe(language)
  })

  it('clears the warning and allows route testing after an explicit English choice', () => {
    const transcription = { provider: 'remote-worker', remoteAsrModel: 'Edge0/Audio8-ASR-Infinite', language: 'es' }
    useConfigStore.setState({ config: { transcription } as never })
    render(<AudioExecutionSettings provider="remote-worker" />)
    fireEvent.change(screen.getByLabelText('Audio language'), { target: { value: 'en' } })
    expect(updateConfig).toHaveBeenCalledWith('transcription', { language: 'en' })
    act(() => useConfigStore.setState({ config: { transcription: { ...transcription, language: 'en' } } as never }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test selected route' })).not.toBeDisabled()
  })
  it('blocks route testing until the selected ASR model has finished saving', async () => {
    let finish!: () => void
    updateConfig.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    render(<AudioExecutionSettings provider="remote-worker" />)
    const select = screen.getByLabelText('Remote transcription model')
    const test = screen.getByRole('button', { name: 'Test selected route' })
    await waitFor(() => expect(screen.getByRole('option', { name: /Qwen.*0.6B.*ready/ })).not.toBeDisabled())
    fireEvent.change(select, { target: { value: 'Qwen/Qwen3-ASR-0.6B' } })
    expect(select).toBeDisabled()
    expect(test).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('')
    await act(async () => { finish() })
    expect(test).not.toBeDisabled()
    expect(select).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Saved.')
  })

  it('preserves an unavailable selection and gates choices until paired capabilities advertise them', async () => {
    hostStatus.mockResolvedValueOnce({ success: true, status: { paired: false, health: {
      asrModels: ['Qwen/Qwen3-ASR-0.6B']
    } } })
    useConfigStore.setState({ config: { transcription: { provider: 'remote-worker',
      remoteAsrModel: 'Qwen/Qwen3-ASR-0.6B' } } as never })
    render(<AudioExecutionSettings provider="remote-worker" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh available models' })).not.toBeDisabled())
    expect(screen.getByLabelText('Remote transcription model')).toHaveValue('Qwen/Qwen3-ASR-0.6B')
    expect(screen.getByRole('option', { name: /Qwen.*0.6B.*unavailable/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Prepare model' })).toBeDisabled()
    expect(updateConfig).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh available models' }))
    await waitFor(() => expect(screen.getByRole('option', { name: /Qwen.*0.6B.*ready/ })).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Prepare model' })).not.toBeDisabled()
    expect(updateConfig).not.toHaveBeenCalled()
  })

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

  it('saves the speaker CPU share, 50% by default', () => {
    render(<DiarizationCpuShare />)
    const select = screen.getByLabelText('CPU share for local processing') as HTMLSelectElement
    expect(select.value).toBe('50')
    fireEvent.change(select, { target: { value: '25' } })
    expect(updateConfig).toHaveBeenCalledWith('transcription', { speakerLinkingCpuPercent: 25 })
  })
})
