/**
 * chat-llm hands every call to the runner with the step the caller named, and gives the callers back what
 * they always got: the text, null when nobody answered, the original error when the routing itself failed.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config', () => ({ getConfig: () => ({ transcription: { geminiApiKey: '' } }) }))
vi.mock('../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

const runText = vi.hoisted(() => vi.fn())
vi.mock('../pipeline/runner', () => ({ runText }))

import { getChatLLMService, resetChatLLMService } from '../chat-llm'

const MESSAGES = [{ role: 'user' as const, content: 'hi' }]

describe('ChatLLMService through the runner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatLLMService()
    runText.mockResolvedValue({ ok: true, text: 'answer', provider: 'gemini-api', callId: 'c1' })
  })

  it('sends the step, the recording and exactly the options the router always got', async () => {
    const signal = new AbortController().signal
    const shouldGenerate = () => true
    const out = await getChatLLMService().generate(MESSAGES, {
      step: 'self-id',
      recordingId: 'rec-1',
      systemPrompt: 'sys',
      temperature: 0,
      maxTokens: 1024,
      signal,
      shouldGenerate
    })
    expect(out).toBe('answer')
    expect(runText).toHaveBeenCalledWith({
      step: 'self-id',
      messages: MESSAGES,
      recordingId: 'rec-1',
      options: { systemPrompt: 'sys', temperature: 0, maxTokens: 1024, signal, shouldGenerate }
    })
  })

  it('is the assistant chat step, with no recording, when the caller names neither', async () => {
    await getChatLLMService().generate(MESSAGES)
    expect(runText).toHaveBeenCalledWith(expect.objectContaining({ step: 'chat', recordingId: null }))
  })

  it('returns null when nobody answered, whatever the reason', async () => {
    for (const reason of ['empty', 'unavailable', 'ineligible'] as const) {
      runText.mockResolvedValue({ ok: false, reason, callId: null })
      expect(await getChatLLMService().generate(MESSAGES)).toBeNull()
    }
  })

  it('throws the original error when the runner reports one', async () => {
    const boom = new Error('router bug')
    runText.mockResolvedValue({ ok: false, reason: 'error', error: boom, callId: 'c1' })
    await expect(getChatLLMService().generate(MESSAGES)).rejects.toBe(boom)
  })

  it('generateText sends one user message and passes the step, the recording and the gate', async () => {
    const shouldGenerate = () => true
    await getChatLLMService().generateText('the prompt', 'the system', { step: 'meeting-pick', recordingId: 'rec-2', shouldGenerate })
    expect(runText).toHaveBeenCalledWith({
      step: 'meeting-pick',
      messages: [{ role: 'user', content: 'the prompt' }],
      recordingId: 'rec-2',
      options: { systemPrompt: 'the system', shouldGenerate }
    })
  })
})
