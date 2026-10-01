/**
 * analyzeNote asks the notes step through the runner, with the options it always used, and turns every
 * kind of outcome into what the editor shows: an analysis, a failed mark with a reason, or the note as is.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/tmp'), getName: vi.fn().mockReturnValue('test') } }))
vi.mock('../vector-store', () => ({ getVectorStore: vi.fn() }))
vi.mock('../database', () => ({ getDatabase: vi.fn(), queryAll: vi.fn(), queryOne: vi.fn() }))

const runText = vi.hoisted(() => vi.fn())
vi.mock('../pipeline/runner', () => ({ runText }))

const notes = vi.hoisted(() => ({
  getNote: vi.fn(),
  needsAnalysis: vi.fn(() => true),
  markAnalysisPending: vi.fn(),
  markAnalysisFailed: vi.fn(),
  applyAnalysis: vi.fn(),
  contentFingerprint: vi.fn(() => 'hash-1')
}))
vi.mock('../notes', () => notes)

import { analyzeNote } from '../note-intelligence'

const GOOD = JSON.stringify({ title: 'Presupuesto', summary: 'Dos líneas.', category: 'decision', tags: ['finanzas'] })

describe('analyzeNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notes.getNote.mockReturnValue({ id: 'n1', content: 'El presupuesto de septiembre' })
    notes.needsAnalysis.mockReturnValue(true)
    notes.applyAnalysis.mockReturnValue({ id: 'n1', analyzed: true })
    runText.mockResolvedValue({ ok: true, text: GOOD, provider: 'gemini-api', callId: 'c1' })
  })

  it('asks the notes step with the note text and the options it always used, and applies the analysis', async () => {
    const result = await analyzeNote('n1')
    expect(runText).toHaveBeenCalledWith({
      step: 'notes',
      messages: [{ role: 'user', content: 'El presupuesto de septiembre' }],
      options: { systemPrompt: expect.stringContaining('You organise short hand-written notes'), temperature: 0.2, maxTokens: 500 }
    })
    expect(notes.applyAnalysis).toHaveBeenCalledWith('n1', expect.objectContaining({ category: 'decision' }), 'hash-1')
    expect(result).toEqual({ id: 'n1', analyzed: true })
  })

  it('marks the analysis failed, with the usual reason, when nobody answered', async () => {
    runText.mockResolvedValue({ ok: false, reason: 'empty', callId: 'c1' })
    await analyzeNote('n1')
    expect(notes.markAnalysisFailed).toHaveBeenCalledWith('n1', 'The model did not return a result this note could use.')
    expect(notes.applyAnalysis).not.toHaveBeenCalled()
  })

  it('marks the analysis failed with the error message when the routing failed', async () => {
    runText.mockResolvedValue({ ok: false, reason: 'error', error: new Error('router bug'), callId: 'c1' })
    await analyzeNote('n1')
    expect(notes.markAnalysisFailed).toHaveBeenCalledWith('n1', 'router bug')
  })

  it('does not ask for an empty note, or one that needs no analysis', async () => {
    notes.getNote.mockReturnValue({ id: 'n1', content: '   ' })
    await analyzeNote('n1')
    notes.getNote.mockReturnValue({ id: 'n1', content: 'text' })
    notes.needsAnalysis.mockReturnValue(false)
    await analyzeNote('n1')
    expect(runText).not.toHaveBeenCalled()
  })
})
