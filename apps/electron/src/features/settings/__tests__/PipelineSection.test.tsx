import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { emptyPipelineConfig, type HarnessState, type PipelineConfig, type PipelineSettingsState } from '@/shared/pipeline-config'
import { PipelineSection } from '../PipelineSection'

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('@/components/ui/toaster', () => ({ toast: toasts }))

const getState = vi.fn()
const saveStep = vi.fn()
const listModels = vi.fn()

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const harness = (over: Partial<HarnessState> & { id: string }): HarnessState => ({
  label: over.id,
  vendor: 'v',
  kind: 'api',
  textCapable: true,
  modelSelectable: true,
  effortLevels: null,
  dataLeavesMachine: true,
  latency: 'fast',
  available: true,
  reason: null,
  ...over
})

const HARNESSES: HarnessState[] = [
  harness({ id: 'gemini-api', label: 'Gemini (API key)', vendor: 'Google' }),
  harness({ id: 'ollama', label: 'Ollama', vendor: 'local', kind: 'local', dataLeavesMachine: false, latency: 'medium' }),
  harness({ id: 'claude-code', label: 'Claude Code SDK', vendor: 'Anthropic', kind: 'cli', latency: 'slow', effortLevels: EFFORTS, available: false, reason: 'Not signed in' }),
  harness({ id: 'kiro', label: 'Kiro', vendor: 'AWS', kind: 'cli', latency: 'slow', modelSelectable: false, effortLevels: EFFORTS })
]

const stateWith = (config: PipelineConfig = emptyPipelineConfig()): PipelineSettingsState => ({
  config,
  harnesses: HARNESSES,
  stats: { notes: { calls: 12, failed: 1, medianMs: 2100, medianCostUsd: 0.0003 } }
})

const planOf = (profile: string, onFail?: string) => ({
  passes: [{ calls: [{ profile, tasks: '*' as const, role: 'produce' as const, ...(onFail ? { onFail: { profile: onFail } } : {}) }] }]
})

const row = (step: string) => screen.findByTestId(`step-${step}`)

async function openEditor(step: string, label: string) {
  const item = await row(step)
  fireEvent.click(within(item).getByRole('button', { name: `Edit ${label}` }))
  return item
}

beforeEach(() => {
  vi.clearAllMocks()
  getState.mockResolvedValue(stateWith())
  saveStep.mockResolvedValue({ success: true, issues: [] })
  listModels.mockResolvedValue([])
  global.window.electronAPI = { pipeline: { getState, saveStep, listModels } } as never
})

describe('PipelineSection', () => {
  it('shows every step under its group, each on Automatic with where its text goes and its numbers', async () => {
    render(<PipelineSection />)
    for (const group of ['Interactive', 'Speakers', 'Library']) {
      expect(await screen.findByRole('heading', { name: group })).toBeInTheDocument()
    }
    const chat = await row('chat')
    expect(within(chat).getByText('Assistant chat')).toBeInTheDocument()
    expect(within(chat).getByText('Automatic')).toBeInTheDocument()
    expect(within(chat).getByText('Follows AI providers')).toBeInTheDocument()
    expect(within(chat).getByText('No calls yet')).toBeInTheDocument()
    expect(within(await row('notes')).getByText('Median 2.1 s · $0.0003 · 12 calls · 1 failed')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Edit / })).toHaveLength(9)
  })

  it('opens the editor, offers the harnesses, and greys out the one that cannot serve with its reason', async () => {
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    const main = within(item).getByLabelText('Main choice') as HTMLSelectElement
    const options = within(main).getAllByRole('option')
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['auto', 'gemini-api', 'ollama', 'claude-code', 'kiro'])
    const claude = options.find((o) => (o as HTMLOptionElement).value === 'claude-code') as HTMLOptionElement
    expect(claude.disabled).toBe(true)
    expect(claude.textContent).toMatch(/Not signed in/)
    expect((options[1] as HTMLOptionElement).disabled).toBe(false)
  })

  it('saves a main choice with its model as a draft the main process understands', async () => {
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'gemini-api' } })
    fireEvent.change(await within(item).findByLabelText('Model'), { target: { value: 'gemini-3.8-flash' } })
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveStep).toHaveBeenCalledWith({ step: 'notes', primary: { harness: 'gemini-api', model: 'gemini-3.8-flash' }, fallback: null, confirmSlow: false })
    )
    await waitFor(() => expect(toasts.success).toHaveBeenCalled())
  })

  it('reloads the state after a save and closes the editor', async () => {
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'ollama' } })
    getState.mockResolvedValue(stateWith({ version: 1, profiles: { ollama: { harness: 'ollama' } }, steps: { notes: planOf('ollama') } }))
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(screen.getByTestId('step-notes')).getByText('Ollama')).toBeInTheDocument())
    expect(within(screen.getByTestId('step-notes')).queryByLabelText('Main choice')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('step-notes')).getByText('Stays on this computer')).toBeInTheDocument()
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it('shows the models the harness lists as suggestions, and keeps a name that is not in the list', async () => {
    listModels.mockResolvedValue([{ id: 'qwen3:8b' }, { id: 'llama3.2:3b', label: 'Llama 3.2' }])
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'ollama' } })
    await waitFor(() => expect(listModels).toHaveBeenCalledWith({ harness: 'ollama' }))
    const model = (await within(item).findByLabelText('Model')) as HTMLInputElement
    await waitFor(() => expect(item.querySelectorAll(`datalist#${model.getAttribute('list')} option`)).toHaveLength(2))
    fireEvent.change(model, { target: { value: 'my-own-model' } })
    expect(model.value).toBe('my-own-model')
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveStep).toHaveBeenCalledWith({ step: 'notes', primary: { harness: 'ollama', model: 'my-own-model' }, fallback: null, confirmSlow: false })
    )
  })

  it('hides the model for a harness that ignores it, and the effort for one that has no levels', async () => {
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    const main = within(item).getByLabelText('Main choice')
    fireEvent.change(main, { target: { value: 'kiro' } })
    expect(within(item).queryByLabelText('Model')).not.toBeInTheDocument()
    expect(within(item).getByLabelText('Effort')).toBeInTheDocument()
    fireEvent.change(main, { target: { value: 'gemini-api' } })
    expect(within(item).getByLabelText('Model')).toBeInTheDocument()
    expect(within(item).queryByLabelText('Effort')).not.toBeInTheDocument()
    fireEvent.change(main, { target: { value: 'auto' } })
    expect(within(item).queryByLabelText('Model')).not.toBeInTheDocument()
    expect(within(item).queryByLabelText('Effort')).not.toBeInTheDocument()
  })

  it('offers Default first in the effort list and sends the level chosen', async () => {
    getState.mockResolvedValue({ ...stateWith(), harnesses: HARNESSES.map((h) => (h.id === 'claude-code' ? { ...h, available: true, reason: null } : h)) })
    render(<PipelineSection />)
    const item = await openEditor('chat', 'Assistant chat')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'claude-code' } })
    const effort = within(item).getByLabelText('Effort') as HTMLSelectElement
    expect(within(effort).getAllByRole('option').map((o) => o.textContent)).toEqual(['Default', 'low', 'medium', 'high', 'xhigh', 'max'])
    fireEvent.change(effort, { target: { value: 'low' } })
    fireEvent.change(within(item).getByLabelText('Model'), { target: { value: 'haiku' } })
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveStep).toHaveBeenCalledWith({ step: 'chat', primary: { harness: 'claude-code', model: 'haiku', effort: 'low' }, fallback: null, confirmSlow: false })
    )
  })

  it('saves a fallback, and refuses the same choice twice with the message and Save off', async () => {
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'gemini-api' } })
    fireEvent.change(within(item).getByLabelText('Fallback'), { target: { value: 'gemini-api' } })
    expect(within(item).getByText(/fallback is the same as the main choice/i)).toBeInTheDocument()
    expect(within(item).getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(within(item).getByLabelText('Fallback'), { target: { value: 'ollama' } })
    expect(within(item).queryByText(/fallback is the same/i)).not.toBeInTheDocument()
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveStep).toHaveBeenCalledWith({ step: 'notes', primary: { harness: 'gemini-api' }, fallback: { harness: 'ollama' }, confirmSlow: false })
    )
  })

  it('asks for the confirmation of a slow harness on a step that runs in bulk, and sends it when checked', async () => {
    render(<PipelineSection />)
    const item = await openEditor('self-id', 'Speaker introductions')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'kiro' } })
    const save = within(item).getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.click(within(item).getByLabelText('I understand each call takes seconds'))
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(saveStep).toHaveBeenCalledWith({ step: 'self-id', primary: { harness: 'kiro' }, fallback: null, confirmSlow: true }))
  })

  it('does not ask for the confirmation on an interactive step', async () => {
    render(<PipelineSection />)
    const item = await openEditor('chat', 'Assistant chat')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'kiro' } })
    expect(within(item).queryByLabelText('I understand each call takes seconds')).not.toBeInTheDocument()
    expect(within(item).getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('"Use Automatic" sends the Automatic choice with no fallback', async () => {
    getState.mockResolvedValue(stateWith({ version: 1, profiles: { ollama: { harness: 'ollama' } }, steps: { notes: planOf('ollama') } }))
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    fireEvent.click(within(item).getByRole('button', { name: 'Use Automatic' }))
    await waitFor(() => expect(saveStep).toHaveBeenCalledWith({ step: 'notes', primary: 'auto', fallback: null, confirmSlow: false }))
  })

  it('shows what the main process refused and keeps the editor open', async () => {
    saveStep.mockResolvedValue({ success: false, issues: [{ severity: 'error', message: 'Ollama is not a known harness.' }] })
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'ollama' } })
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))
    expect(await within(item).findByText('Ollama is not a known harness.')).toBeInTheDocument()
    expect(within(item).getByLabelText('Main choice')).toBeInTheDocument()
  })

  it('shows a failed write as an error and keeps the editor open', async () => {
    saveStep.mockResolvedValue({ success: false, error: 'disk full' })
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    fireEvent.change(within(item).getByLabelText('Main choice'), { target: { value: 'ollama' } })
    fireEvent.click(within(item).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/disk full/)))
    expect(within(item).getByLabelText('Main choice')).toBeInTheDocument()
  })

  it('closes the editor on Cancel without saving', async () => {
    render(<PipelineSection />)
    const item = await openEditor('notes', 'Note analysis')
    fireEvent.click(within(item).getByRole('button', { name: 'Cancel' }))
    expect(within(item).queryByLabelText('Main choice')).not.toBeInTheDocument()
    expect(saveStep).not.toHaveBeenCalled()
  })

  it('says so, and offers Retry, when the state cannot be loaded', async () => {
    getState.mockRejectedValueOnce(new Error('ipc down'))
    render(<PipelineSection />)
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await row('chat')).toBeInTheDocument()
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it('reads a saved plan into the row, and the editor opens on it', async () => {
    getState.mockResolvedValue(
      stateWith({
        version: 1,
        profiles: { 'ollama-qwen3-8b': { harness: 'ollama', model: 'qwen3:8b' }, g: { harness: 'gemini-api' } },
        steps: { notes: planOf('ollama-qwen3-8b', 'g') }
      })
    )
    render(<PipelineSection />)
    const item = await row('notes')
    expect(within(item).getByText('Ollama · qwen3:8b, then Gemini (API key)')).toBeInTheDocument()
    expect(within(item).getByText('Sent to Google')).toBeInTheDocument()
    fireEvent.click(within(item).getByRole('button', { name: 'Edit Note analysis' }))
    expect((within(item).getByLabelText('Main choice') as HTMLSelectElement).value).toBe('ollama')
    expect((within(item).getByLabelText('Model') as HTMLInputElement).value).toBe('qwen3:8b')
    expect((within(item).getByLabelText('Fallback') as HTMLSelectElement).value).toBe('gemini-api')
  })

  it('says why a saved plan is ignored, on its row, and not on the others', async () => {
    getState.mockResolvedValue(stateWith({ version: 1, profiles: {}, steps: { notes: planOf('ghost') } }))
    render(<PipelineSection />)
    const item = await row('notes')
    expect(within(item).getByText(/ignored/i)).toBeInTheDocument()
    expect(within(item).getByText(/"ghost", which does not exist/)).toBeInTheDocument()
    expect(within(await row('chat')).queryByText(/ignored/i)).not.toBeInTheDocument()
  })
})
