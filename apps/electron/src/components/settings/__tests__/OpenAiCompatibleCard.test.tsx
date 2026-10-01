import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { OpenAiCompatibleCard } from '../OpenAiCompatibleCard'

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('@/components/ui/toaster', () => ({ toast: toasts }))

const getConnection = vi.fn()
const setConnection = vi.fn()
const setCredential = vi.fn()

const SAVED = { baseUrl: 'http://localhost:1234/v1', model: '', embeddingModel: '', hasKey: false }

beforeEach(() => {
  vi.clearAllMocks()
  getConnection.mockResolvedValue(SAVED)
  setConnection.mockResolvedValue({ success: true })
  setCredential.mockResolvedValue({ success: true })
  global.window.electronAPI = {
    brains: { getOpenAiCompatible: getConnection, setOpenAiCompatible: setConnection, setCredential }
  } as never
})

const field = (name: RegExp) => screen.findByLabelText(name) as Promise<HTMLInputElement>

describe('OpenAiCompatibleCard', () => {
  it('shows the saved address and models, with what to put in each', async () => {
    getConnection.mockResolvedValue({ baseUrl: 'http://10.0.0.5:8000/v1', model: 'qwen3-8b', embeddingModel: 'nomic', hasKey: false })
    render(<OpenAiCompatibleCard onSaved={vi.fn()} />)
    expect((await field(/^Address/)).value).toBe('http://10.0.0.5:8000/v1')
    expect((await field(/^Model$/)).value).toBe('qwen3-8b')
    expect((await field(/^Embedding model/)).value).toBe('nomic')
    expect(screen.getByText(/Include \/v1/)).toBeInTheDocument()
    expect(screen.getByText(/the model the server has loaded/i)).toBeInTheDocument()
  })

  it('keeps Save off until something changes, then saves the trimmed values and tells the page', async () => {
    const onSaved = vi.fn()
    render(<OpenAiCompatibleCard onSaved={onSaved} />)
    const save = await screen.findByRole('button', { name: /^Save connection$/ })
    expect(save).toBeDisabled()
    fireEvent.change(await field(/^Model$/), { target: { value: '  qwen3-8b ' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() =>
      expect(setConnection).toHaveBeenCalledWith({ baseUrl: 'http://localhost:1234/v1', model: 'qwen3-8b', embeddingModel: '' })
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(toasts.success).toHaveBeenCalled()
    expect(save).toBeDisabled()
  })

  it('shows what the main process refused and does not tell the page it saved', async () => {
    setConnection.mockResolvedValue({ success: false, error: 'The address must start with http:// or https://.' })
    const onSaved = vi.fn()
    render(<OpenAiCompatibleCard onSaved={onSaved} />)
    fireEvent.change(await field(/^Address/), { target: { value: 'localhost:1234' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save connection$/ }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/http:\/\//)))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Save connection$/ })).toBeEnabled()
  })

  it('saves a key through the credential store, clears the field, and never shows the key', async () => {
    render(<OpenAiCompatibleCard onSaved={vi.fn()} />)
    const key = await field(/^API key/)
    expect(key.type).toBe('password')
    fireEvent.change(key, { target: { value: 'sk-secret' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save key$/ }))
    await waitFor(() => expect(setCredential).toHaveBeenCalledWith({ id: 'openai-compatible', field: 'apiKey', value: 'sk-secret' }))
    expect(await screen.findByText(/Key saved/)).toBeInTheDocument()
    expect(key.value).toBe('')
    expect(document.body.textContent).not.toContain('sk-secret')
  })

  it('says a key is stored when the main process reports one, and removes it on request', async () => {
    getConnection.mockResolvedValue({ ...SAVED, hasKey: true })
    render(<OpenAiCompatibleCard onSaved={vi.fn()} />)
    expect(await screen.findByText(/Key saved/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Remove key$/ }))
    await waitFor(() => expect(setCredential).toHaveBeenCalledWith({ id: 'openai-compatible', field: 'apiKey', value: null }))
    await waitFor(() => expect(screen.queryByText(/Key saved/)).not.toBeInTheDocument())
  })

  it('does not save an empty key', async () => {
    render(<OpenAiCompatibleCard onSaved={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /^Save key$/ })).toBeDisabled()
  })

  it('shows an error toast, and keeps the card usable, when the key cannot be saved', async () => {
    setCredential.mockRejectedValue(new Error('store locked'))
    render(<OpenAiCompatibleCard onSaved={vi.fn()} />)
    fireEvent.change(await field(/^API key/), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save key$/ }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/store locked/)))
    expect(screen.queryByText(/Key saved/)).not.toBeInTheDocument()
  })

  it('still renders its fields, with the default address, when the connection cannot be read', async () => {
    getConnection.mockRejectedValue(new Error('ipc down'))
    render(<OpenAiCompatibleCard onSaved={vi.fn()} />)
    expect((await field(/^Address/)).value).toBe('http://localhost:1234/v1')
  })
})
