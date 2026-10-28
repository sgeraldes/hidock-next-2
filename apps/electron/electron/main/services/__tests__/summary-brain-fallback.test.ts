/**
 * When Gemini cannot write a summary (no credit, quota, overload), another
 * enabled brain writes it: Claude Code, Codex or a local model (28-oct-2026,
 * Google's 402 "prepayment credits are depleted" left ten recordings with no
 * summary while Claude Code was enabled and logged in).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

const mockConfig: any = {
  transcription: { provider: 'gemini', geminiModel: 'gemini-2.0-flash', valueClassificationEnabled: false },
  chat: { geminiModel: 'gemini-3.8-flash' },
  brains: { taskRouting: {} }
}
vi.mock('../config', () => ({ getConfig: vi.fn(() => mockConfig) }))

const mockGenerateContent = vi.fn()
vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent: (...args: any[]) => mockGenerateContent(...args) }
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI }
})

vi.mock('@hidock/transcription', () => {
  // eslint-disable-next-line require-yield
  const gen = async function* () {
    throw new Error('unused in this suite')
  }
  function GeminiEngine() {
    return { isAvailable: async () => true, isStreaming: false, isLocal: false, transcribe: gen }
  }
  class TranscriptionCancelledError extends Error {}
  return { GeminiEngine, TranscriptionCancelledError }
})

const { mockChatUntil, mockCanServe, geminiKey } = vi.hoisted(() => ({
  mockChatUntil: vi.fn(),
  mockCanServe: vi.fn(),
  geminiKey: { value: 'test-api-key' } // pragma: allowlist secret
}))
vi.mock('../brains', () => ({
  getBrainRegistry: () => ({ get: () => ({ generate: vi.fn() }) }),
  getBrainRouter: () => ({ chatUntil: mockChatUntil, canServe: mockCanServe }),
  resolveGeminiApiKey: () => geminiKey.value
}))

vi.mock('../vector-store', () => ({ getVectorStore: vi.fn(() => null) }))
vi.mock('../meeting-wiki', () => ({ exportMeetingWiki: vi.fn(() => null) }))

let dbCounter = 0
vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => join(tmpdir(), `hidock-summary-fallback-${Date.now()}-${++dbCounter}.sqlite`))
}))

import { initializeDatabase, run as dbRun, queryOne as dbQueryOne } from '../database'
import { reanalyzeFailedTranscripts, textLanguage } from '../transcription'

const BY_BRAIN = JSON.stringify({
  summary: 'Resumen escrito por Claude.',
  action_items: [],
  topics: [],
  key_points: [],
  title_suggestion: 'Reunión de entrega',
  question_suggestions: [],
  language: 'es'
})
const DEPLETED = Object.assign(new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent: [402 Payment Required] Your prepayment credits are depleted.'), { status: 402 })

/** The router answers with `answer` from `brainId`, through the caller's own accept test. */
function brainAnswers(answer: string, brainId = 'claude-code') {
  mockChatUntil.mockImplementation(async (_task: string, _messages: unknown, _opts: unknown, { accept }: { accept: (a: string) => boolean }) =>
    accept(answer) ? { brainId, answer } : null)
}

const SPANISH_MEETING = 'Bueno, buenas tardes, ¿cómo están? Hoy vamos a revisar los artefactos de la práctica y el estado de las certificaciones. ' +
  'Entonces lo que hay que hacer es centralizar el seguimiento en Jira, porque así también vemos qué está maduro y qué no.'

function seed(recordingId: string, fullText = SPANISH_MEETING): void {
  dbRun('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)', [recordingId, `${recordingId}.hda`, '2026-10-27'])
  dbRun(`INSERT INTO transcripts (id, recording_id, full_text, summary, title_suggestion) VALUES (?, ?, ?, NULL, NULL)`,
    [`t-${recordingId}`, recordingId, fullText])
}
const summaryOf = (id: string) => dbQueryOne<{ summary: string | null }>('SELECT summary FROM transcripts WHERE recording_id = ?', [id])?.summary ?? null
const summaryRunOf = (id: string) => dbQueryOne<{ provider: string; tool: string; status: string }>(
  "SELECT provider, tool, status FROM processing_runs WHERE recording_id = ? AND stage = 'summary' ORDER BY started_at DESC LIMIT 1", [id])

beforeEach(async () => {
  vi.clearAllMocks()
  geminiKey.value = 'test-api-key' // pragma: allowlist secret
  mockConfig.brains = { taskRouting: {} }
  mockCanServe.mockImplementation(async (id: string) => id === 'claude-code')
  mockChatUntil.mockResolvedValue(null)
  await initializeDatabase()
})

describe('summary falls back to another brain when Gemini fails', () => {
  it('writes the summary with Claude Code when Gemini has no credit, and names it on the run', async () => {
    seed('depleted')
    mockGenerateContent.mockRejectedValue(DEPLETED)
    brainAnswers('```json\n' + BY_BRAIN + '\n```')

    expect(await reanalyzeFailedTranscripts(5)).toBe(1)

    expect(summaryOf('depleted')).toBe('Resumen escrito por Claude.')
    expect(summaryRunOf('depleted')).toMatchObject({ provider: 'claude-code', tool: 'brain-summary', status: 'completed' })
    // Gemini is left out of the router chain: its own path already failed.
    expect(mockChatUntil.mock.calls[0][0]).toBe('summary')
    // Local models are left out too unless chosen: a small default model cuts
    // the transcript to its context and loads the display GPU.
    expect(mockChatUntil.mock.calls[0][3].exclude).toEqual(['gemini-api', 'ollama', 'openai-compatible', 'model-host-generate'])
  })

  it('lets a local model write summaries when Settings routes them there', async () => {
    seed('local')
    mockConfig.brains = { taskRouting: { summary: 'ollama' } }
    brainAnswers(BY_BRAIN, 'ollama')

    expect(await reanalyzeFailedTranscripts(5)).toBe(1)

    expect(mockChatUntil.mock.calls[0][3].exclude).toEqual(['gemini-api', 'openai-compatible', 'model-host-generate'])
    expect(summaryRunOf('local')).toMatchObject({ provider: 'ollama' })
  })

  it('keeps the Gemini failure when no brain gives a summary that parses', async () => {
    seed('nobody')
    mockGenerateContent.mockRejectedValue(DEPLETED)
    brainAnswers('Lo siento, no puedo ayudar con eso.')

    await reanalyzeFailedTranscripts(5)

    expect(summaryOf('nobody')).toBeNull()
    expect(summaryRunOf('nobody')).toMatchObject({ provider: 'gemini', status: 'failed' })
  })

  it('asks the routed brain first and never calls Gemini when it answers', async () => {
    seed('routed')
    mockConfig.brains = { taskRouting: { summary: 'codex' } }
    brainAnswers(BY_BRAIN, 'codex')

    expect(await reanalyzeFailedTranscripts(5)).toBe(1)

    expect(mockGenerateContent).not.toHaveBeenCalled()
    expect(summaryRunOf('routed')).toMatchObject({ provider: 'codex' })
  })

  it('heals summaries with no Gemini key at all when another brain is ready', async () => {
    seed('no-key')
    geminiKey.value = ''
    brainAnswers(BY_BRAIN)

    expect(await reanalyzeFailedTranscripts(5)).toBe(1)

    expect(summaryOf('no-key')).toBe('Resumen escrito por Claude.')
  })

  it('does nothing without a Gemini key when no other brain is ready', async () => {
    seed('none-ready')
    geminiKey.value = ''
    mockCanServe.mockResolvedValue(false)

    expect(await reanalyzeFailedTranscripts(5)).toBe(0)

    expect(mockChatUntil).not.toHaveBeenCalled()
  })

  it('does not count an unrouted local model as ready, so the heal does not loop (review of #191)', async () => {
    seed('only-ollama')
    geminiKey.value = ''
    mockCanServe.mockImplementation(async (id: string) => id === 'ollama')

    expect(await reanalyzeFailedTranscripts(5)).toBe(0)

    expect(mockCanServe).not.toHaveBeenCalledWith('ollama', 'chat')
    expect(summaryOf('only-ollama')).toBeNull()
  })

  it('never saves the no-brain placeholder as a healed summary (review of #191)', async () => {
    seed('placeholder')
    geminiKey.value = ''
    mockChatUntil.mockResolvedValue(null)

    expect(await reanalyzeFailedTranscripts(5)).toBe(0)

    expect(summaryOf('placeholder')).toBeNull()
  })

  it('turns away a summary written in another language than the meeting (28-oct-2026)', async () => {
    seed('wrong-language')
    mockGenerateContent.mockRejectedValue(DEPLETED)
    brainAnswers(JSON.stringify({
      summary: 'The meeting shifted from discussing proposed reusable artifacts to tracking the existing ones, and the team agreed to centralize this in Jira.',
      title_suggestion: 'Artifact Tracking and Certification Commitments',
      language: 'en'
    }), 'codex')

    await reanalyzeFailedTranscripts(5)

    expect(summaryOf('wrong-language')).toBeNull()
    // The brain is told the language up front.
    expect(mockChatUntil.mock.calls[0][2].systemPrompt).toMatch(/in Spanish/)
  })
})

describe('textLanguage', () => {
  it('reads Spanish and English from their commonest words, and abstains on too little text', () => {
    expect(textLanguage(SPANISH_MEETING)).toBe('es')
    expect(textLanguage('The meeting shifted from discussing the artifacts to tracking the ones that we have, and the team agreed on it.')).toBe('en')
    expect(textLanguage('Jira, AWS, OK')).toBeNull()
  })
})
