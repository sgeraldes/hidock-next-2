import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerTranscriptsHandlers } from '../transcripts-handlers'

const getTranscriptTiming = vi.hoisted(() => vi.fn())
const loadTimingState = vi.hoisted(() => vi.fn())
vi.mock('../../services/transcript-timing-store', () => ({ getTranscriptTiming, loadTimingState }))
// The section transcriber is a mock: no test ever reaches a paid provider.
const transcribeRecordingSection = vi.hoisted(() => vi.fn())
vi.mock('../../services/transcription', () => ({ transcribeRecordingSection, retrySummary: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const db = vi.hoisted(() => ({
  getRecordingById: vi.fn(),
  resolveRecordingId: vi.fn(),
  queryOne: vi.fn(),
  queryAll: vi.fn(() => []),
  saveDatabase: vi.fn(),
  runInTransaction: vi.fn((fn: () => unknown) => fn()),
  runNoSave: vi.fn(),
  run: vi.fn(),
  assignSpeaker: vi.fn(),
  getSpeakerMap: vi.fn(),
  unassignSpeaker: vi.fn(),
  getActiveProcessingRunsForRecording: vi.fn(),
  refreshTranscriptIntegrity: vi.fn()
}))

const vectorStore = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  dropByRecordingFromMemory: vi.fn(),
  deleteByRecording: vi.fn(),
  indexTranscript: vi.fn()
}))

const isRecordingEligible = vi.hoisted(() => vi.fn())
const exportMeetingWiki = vi.hoisted(() => vi.fn())

vi.mock('../../services/database', () => db)
vi.mock('../../services/vector-store', () => ({ getVectorStore: () => vectorStore }))
vi.mock('../../services/recording-eligibility', () => ({ isRecordingEligible }))
vi.mock('../../services/meeting-wiki', () => ({ exportMeetingWiki }))

function handlerFor(channel: string) {
  return vi.mocked(ipcMain.handle).mock.calls.find((call) => call[0] === channel)?.[1]
}

const request = {
  recordingId: 'rec-1',
  expectedFullText: 'Voice ABC: wrong words',
  segments: [{ speaker: 'Voice ABC', start: 23, end: 35, text: 'Aló Aló, Sorry recién te leo' }]
}

describe('transcript content editing IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isRecordingEligible.mockReturnValue(true)
    db.getRecordingById.mockReturnValue({
      id: 'rec-1',
      meeting_id: null,
      date_recorded: '2026-08-27T18:00:00.000Z',
      created_at: '2026-08-27T18:00:00.000Z'
    })
    db.queryOne.mockReturnValue({ full_text: request.expectedFullText })
    vectorStore.indexTranscript.mockResolvedValue(3)
    vectorStore.deleteByRecording.mockResolvedValue(3)
  })

  it('registers the edit and retry channels', () => {
    registerTranscriptsHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('transcripts:updateContent', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('transcripts:reindex', expect.any(Function))
  })

  it('restores immutable stored channel evidence after a one-line edit, ignoring forged renderer evidence', async () => {
    const stored = [0, 1].map(sourceChannel => ({
      speaker: `ch${sourceChannel}:speaker0`, start: 1, end: 5, text: `words ${sourceChannel}`,
      sourceChannel, channelRole: 'unknown', channelProvenance: 'unverified', privateExtra: 'not forwarded'
    }))
    db.queryOne.mockReturnValue({ full_text: request.expectedFullText, speakers: JSON.stringify(stored) })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, {
      ...request, expectedSegments: stored,
      segments: stored.map((row, index) => ({ ...row, ...(index === 0 ? { text: 'corrected', start: 2, speaker: 'renamed' } : {}),
        sourceChannel: 99, channelRole: 'owner', channelProvenance: 'manual-confirmed' }))
    }) as any
    expect(result.success).toBe(true)
    const saved = JSON.parse(db.runNoSave.mock.calls[0][1][1])
    expect(saved).toEqual(stored.map(({privateExtra: _ignored, ...row}, index) => ({ ...row,
      ...(index === 0 ? { text: 'corrected', start: 2, speaker: 'renamed' } : {}) })))
    expect(result.data.segments).toEqual(saved)
  })

  it.each(['missing-snapshot', 'removed-line', 'reordered-lines'])('rejects ambiguous channel mapping: %s', async mode => {
    const stored = [0, 1].map(sourceChannel => ({speaker: `ch${sourceChannel}:speaker0`, start: 1, end: 5,
      text: `words ${sourceChannel}`, sourceChannel, channelRole: 'unknown', channelProvenance: 'unverified'}))
    db.queryOne.mockReturnValue({ full_text: request.expectedFullText, speakers: JSON.stringify(stored) })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, {
      ...request, ...(mode === 'missing-snapshot' ? {} : { expectedSegments: stored }),
      segments: mode === 'removed-line' ? stored.slice(0, 1) : mode === 'reordered-lines' ? [...stored].reverse() : stored
    }) as any
    expect(result).toMatchObject({success:false,error:{code:'VALIDATION_ERROR'}})
    expect(db.runNoSave).not.toHaveBeenCalled()
    expect(vectorStore.indexTranscript).not.toHaveBeenCalled()
  })

  it('does not introduce renderer-supplied channel evidence into a legacy transcript', async () => {
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, {
      ...request, segments: request.segments.map(row => ({...row, sourceChannel: 0, channelRole: 'owner', channelProvenance: 'forged'}))
    }) as any
    expect(result.success).toBe(true)
    expect(result.data.segments).toEqual(request.segments)
  })

  it('Retry RAG preserves every existing partition on failure and accepts already-current chunks', async () => {
    registerTranscriptsHandlers()
    vectorStore.indexTranscript.mockRejectedValueOnce(new Error('host unavailable'))
    const failed = await handlerFor('transcripts:reindex')?.({} as never, {recordingId:'rec-1'}) as any
    expect(failed.success).toBe(false)
    expect(vectorStore.deleteByRecording).not.toHaveBeenCalled()
    expect(db.runNoSave).not.toHaveBeenCalled()
    vectorStore.indexTranscript.mockResolvedValueOnce(0)
    const unchanged = await handlerFor('transcripts:reindex')?.({} as never, {recordingId:'rec-1'}) as any
    expect(unchanged).toMatchObject({success:true,data:{indexedChunks:0}})
    expect(vectorStore.deleteByRecording).not.toHaveBeenCalled()
  })

  it('atomically saves both transcript forms, invalidates stale vectors, and reindexes', async () => {
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, request) as any

    expect(result).toMatchObject({ success: true, data: { ragStatus: 'indexed', indexedChunks: 3 } })
    expect(db.runNoSave).toHaveBeenNthCalledWith(
      1,
      'UPDATE transcripts SET full_text = ?, speakers = ?, word_count = ? WHERE recording_id = ?',
      [
        'Voice ABC: Aló Aló, Sorry recién te leo',
        JSON.stringify(request.segments),
        8,
        'rec-1'
      ]
    )
    expect(db.runNoSave).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM vector_embeddings WHERE recording_id = ?',
      ['rec-1']
    )
    expect(vectorStore.dropByRecordingFromMemory).toHaveBeenCalledWith('rec-1')
    expect(vectorStore.indexTranscript).toHaveBeenCalledWith(
      'Voice ABC: Aló Aló, Sorry recién te leo',
      expect.objectContaining({ recordingId: 'rec-1' })
    )
  })

  it('checks the saved lines again, so a fixed time clears its warning', async () => {
    db.queryOne.mockImplementation((sql: string) =>
      sql.startsWith('SELECT id FROM transcripts') ? { id: 'trans_rec-1' } : { full_text: request.expectedFullText }
    )
    db.refreshTranscriptIntegrity.mockReturnValue({ version: 2, status: 'ok', issues: [] })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, request) as any

    expect(db.refreshTranscriptIntegrity).toHaveBeenCalledWith('trans_rec-1')
    expect(result.data.integrity).toEqual({ status: 'ok', json: JSON.stringify({ version: 2, status: 'ok', issues: [] }) })
  })

  it('saves the correction but reports RAG pending when embeddings fail', async () => {
    vectorStore.indexTranscript.mockRejectedValueOnce(new Error('Embedding provider unavailable'))
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, request) as any

    expect(result).toMatchObject({
      success: true,
      data: { ragStatus: 'pending', indexedChunks: 0, ragError: 'Embedding provider unavailable' }
    })
    expect(db.runNoSave).toHaveBeenCalledWith(
      'DELETE FROM vector_embeddings WHERE recording_id = ?',
      ['rec-1']
    )
  })

  it('saves a transcript whose lines start slightly out of order and keeps speaker attribution', async () => {
    // Real case (28-sep-2026): overlapping speech gave a line starting 1 s
    // before the previous one, and the old order rule refused every edit.
    const segments = [
      { speaker: 'A', start: 1004.2, end: 1006, text: 'Bueno', speakerAttribution: 'acoustic', speakerConfidence: 0.91 },
      { speaker: 'B', start: 1003.2, end: 1004, text: '(noise)', speakerAttribution: 'unresolved', speakerConfidence: 0 }
    ]
    db.queryOne.mockReturnValue({ full_text: 'A: Bueno' })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, {
      recordingId: 'rec-1',
      expectedFullText: 'A: Bueno',
      segments
    }) as any

    expect(result).toMatchObject({ success: true })
    const saved = JSON.parse(vi.mocked(db.runNoSave).mock.calls[0][1][1] as string)
    expect(saved).toEqual(segments)
  })

  it('refuses a save when another editor changed a time since this one loaded', async () => {
    db.queryOne.mockReturnValue({
      full_text: request.expectedFullText,
      speakers: JSON.stringify([{ speaker: 'Voice ABC', start: 25, end: 35, text: 'wrong words' }])
    })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, {
      ...request,
      expectedSegments: [{ speaker: 'Voice ABC', start: 23, end: 35, text: 'wrong words' }]
    }) as any
    expect(result).toMatchObject({ success: false, error: { code: 'RETRYABLE_ERROR' } })
    expect(db.runNoSave).not.toHaveBeenCalled()
  })

  it('saves when the stored segments are the ones the editor loaded', async () => {
    const stored = [{ speaker: 'Voice ABC', start: 23, end: 35, text: 'wrong words' }]
    db.queryOne.mockReturnValue({ full_text: request.expectedFullText, speakers: JSON.stringify(stored) })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, { ...request, expectedSegments: stored }) as any
    expect(result).toMatchObject({ success: true })
  })

  it('refuses to overwrite a concurrently replaced transcript', async () => {
    db.queryOne.mockReturnValueOnce({ full_text: 'A newer transcription won the race' })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:updateContent')?.({} as never, request) as any

    expect(result).toMatchObject({ success: false, error: { code: 'RETRYABLE_ERROR' } })
    expect(db.runNoSave).not.toHaveBeenCalled()
    expect(vectorStore.indexTranscript).not.toHaveBeenCalled()
  })
})


describe('timing review persistence', () => {
  // Rec28's shape: the 8:14 greeting is listed first, the opening speech is at 4.9 s.
  const segments = [
    { start: 494.8, end: 505.7, text: 'opening greeting here' },
    { start: 13, end: 14, text: 'good morning' },
    { start: 15, end: 16, text: 'how are you' }
  ]
  const speakers = JSON.stringify(segments)
  let fingerprint = ''
  const speech = [{ start: 4.86, end: 5.61 }, { start: 13, end: 14 }, { start: 15, end: 16 }]
  const evidence = {
    hasAudio: (a: number, b: number) => speech.some((s) => s.end > a && s.start < b),
    spansIn: (a: number, b: number) => speech.map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) })).filter((s) => s.end > s.start)
  }
  async function state(withEvidence = evidence) {
    const { assessTimingEvidence } = await import('../../services/transcript-timing-evidence')
    return {
      transcriptId: 't-1', speakers, segments, durationSeconds: 600, evidence: withEvidence,
      assessment: { fingerprint, findings: assessTimingEvidence(segments, withEvidence, 600), hiddenIndices: [], fixedRanges: [], sectionRuns: [], reviewed: false, evidence: 'vad' }
    }
  }
  const stored = () => {
    const update = db.runNoSave.mock.calls.find(([sql]) => sql.startsWith('UPDATE transcripts SET speakers'))
    return update ? { segments: JSON.parse(update[1][0]), fullText: update[1][1] as string } : null
  }
  beforeEach(async () => {
    vi.clearAllMocks()
    const { transcriptFingerprint } = await import('../../services/transcript-validity-store')
    fingerprint = transcriptFingerprint(speakers)
    loadTimingState.mockResolvedValue(await state())
    db.queryOne.mockReturnValue({ id: 't-1', speakers })
    transcribeRecordingSection.mockReset()
  })

  it('refuses a stale review without writing', async () => {
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:reviewTiming')?.({} as never, { recordingId: 'rec-1', fingerprint: 'a'.repeat(40), action: 'hide', indices: [0] }) as any
    expect(result.success).toBe(false)
    expect(db.runNoSave).not.toHaveBeenCalled()
  })

  it('hides a line with a flag, keeps its text stored, and leaves the summary untouched', async () => {
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:reviewTiming')?.({} as never, { recordingId: 'rec-1', fingerprint, action: 'hide', findingId: 'odd_line:0-0' }) as any
    expect(result.success).toBe(true)
    const saved = stored()!
    expect(saved.segments[0]).toMatchObject({ text: 'opening greeting here', timingHidden: true })
    expect(saved.fullText).toBe('good morning\nhow are you')
    expect(db.runNoSave.mock.calls.some(([sql]) => /SET summary/.test(sql))).toBe(false)
  })

  it('fixes times from the speech evidence and keeps the transcriber\'s times for undo', async () => {
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:reviewTiming')?.({} as never, { recordingId: 'rec-1', fingerprint, action: 'fix_times', findingId: 'odd_line:0-0' }) as any
    expect(result.success).toBe(true)
    const line = stored()!.segments[0]
    expect(line.start).toBeCloseTo(4.86, 2)
    expect(line).toMatchObject({ timingOriginalStart: 494.8, timingOriginalEnd: 505.7 })
  })

  it('does not apply a fix the sound cannot support, and says so', async () => {
    const noSpeech = { hasAudio: () => false, spansIn: () => [] }
    loadTimingState.mockResolvedValue(await state(noSpeech))
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:reviewTiming')?.({} as never, { recordingId: 'rec-1', fingerprint, action: 'fix_times', findingId: 'odd_line:0-0' }) as any
    expect(result.success).toBe(false)
    expect(result.error.details).toMatchObject({ lowConfidence: true })
    expect(db.runNoSave).not.toHaveBeenCalled()
  })

  it('transcribes only the section between the trusted lines (mocked provider) and keeps the old line hidden', async () => {
    transcribeRecordingSection.mockResolvedValue({ runId: 'run-9', segments: [{ start: 4.9, end: 5.6, text: 'hola manuel' }] })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:retranscribeSection')?.({} as never, { recordingId: 'rec-1', fingerprint, findingId: 'odd_line:0-0' }) as any
    expect(result.success).toBe(true)
    expect(transcribeRecordingSection).toHaveBeenCalledWith('rec-1', 0, 13, 600)
    const saved = stored()!
    expect(saved.segments[0]).toMatchObject({ text: 'opening greeting here', timingHidden: true, sectionReplacedBy: 'run-9' })
    expect(saved.segments[1]).toMatchObject({ text: 'hola manuel', sectionRunId: 'run-9' })
    expect(saved.fullText.startsWith('hola manuel')).toBe(true)
  })

  it('refuses a section transcription for lines that only overlap, before any provider call', async () => {
    const close = [{ start: 10, end: 12, text: 'uno dos tres' }, { start: 9, end: 11, text: 'cuatro cinco' }, { start: 13, end: 14, text: 'seis' }]
    const { transcriptFingerprint } = await import('../../services/transcript-validity-store')
    const { assessTimingEvidence } = await import('../../services/transcript-timing-evidence')
    const fp = transcriptFingerprint(JSON.stringify(close))
    loadTimingState.mockResolvedValue({ transcriptId: 't-1', speakers: JSON.stringify(close), segments: close, durationSeconds: 60, evidence,
      assessment: { fingerprint: fp, findings: assessTimingEvidence(close, evidence, 60), hiddenIndices: [], fixedRanges: [], sectionRuns: [], reviewed: false, evidence: 'vad' } })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:retranscribeSection')?.({} as never, { recordingId: 'rec-1', fingerprint: fp, findingId: 'odd_line:1-1' }) as any
    expect(result.success).toBe(false)
    expect(transcribeRecordingSection).not.toHaveBeenCalled()
  })

  it('keeps per-turn speaker overrides and splits on their turns when a section transcription adds lines (CodeRabbit review of #195)', async () => {
    transcribeRecordingSection.mockResolvedValue({ runId: 'run-9', segments: [{ start: 4.9, end: 5.4, text: 'hola' }, { start: 5.4, end: 5.6, text: 'manuel' }] })
    db.getRecordingById.mockReturnValue({ id: 'rec-1', meeting_id: null, date_recorded: null, created_at: null })
    registerTranscriptsHandlers()
    await handlerFor('transcripts:retranscribeSection')?.({} as never, { recordingId: 'rec-1', fingerprint, findingId: 'odd_line:0-0' })
    const sql = db.runNoSave.mock.calls.map(([q, params]) => [q.replace(/\s+/g, ' '), params])
    // The replaced line keeps turn 0; turns from 1 on move by the 2 new lines.
    expect(sql).toContainEqual([expect.stringMatching(/^UPDATE turn_speaker_overrides SET turn_index = -\(turn_index \+ \?\) - 1 WHERE recording_id = \? AND turn_index >= \?/), [2, 'rec-1', 1]])
    expect(sql).toContainEqual([expect.stringMatching(/^UPDATE speaker_splits SET from_turn_index = -\(from_turn_index \+ \?\) - 1 WHERE recording_id = \? AND from_turn_index >= \?/), [2, 'rec-1', 1]])
  })

  it('drops the overrides of a section run\'s own turns and moves later ones back when it is undone', async () => {
    const spliced = [
      { start: 494.8, end: 505.7, text: 'opening greeting here', timingHidden: true, sectionReplacedBy: 'run-9' },
      { start: 4.9, end: 5.4, text: 'hola', sectionRunId: 'run-9' }, { start: 5.4, end: 5.6, text: 'manuel', sectionRunId: 'run-9' },
      { start: 13, end: 14, text: 'good morning' }, { start: 15, end: 16, text: 'how are you' }
    ]
    const { transcriptFingerprint } = await import('../../services/transcript-validity-store')
    const fp = transcriptFingerprint(JSON.stringify(spliced))
    loadTimingState.mockResolvedValue({ transcriptId: 't-1', speakers: JSON.stringify(spliced), segments: spliced, durationSeconds: 600, evidence,
      assessment: { fingerprint: fp, findings: [], hiddenIndices: [], fixedRanges: [], sectionRuns: [{ runId: 'run-9', from: 1, to: 2 }], reviewed: true, evidence: 'vad' } })
    db.queryOne.mockReturnValue({ id: 't-1', speakers: JSON.stringify(spliced) })
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:reviewTiming')?.({} as never, { recordingId: 'rec-1', fingerprint: fp, action: 'undo_section', runId: 'run-9' }) as any
    expect(result.success).toBe(true)
    const sql = db.runNoSave.mock.calls.map(([q, params]) => [q.replace(/\s+/g, ' '), params])
    expect(sql).toContainEqual([expect.stringMatching(/^DELETE FROM turn_speaker_overrides WHERE recording_id = \? AND turn_index >= \? AND turn_index < \?/), ['rec-1', 1, 3]])
    expect(sql).toContainEqual([expect.stringMatching(/^UPDATE turn_speaker_overrides SET turn_index = -\(turn_index \+ \?\) - 1/), [-2, 'rec-1', 3]])
  })

  it('does not persist search chunks of a save that a newer save replaced (CodeRabbit review of #195)', async () => {
    db.getRecordingById.mockReturnValue({ id: 'rec-1', meeting_id: null, date_recorded: null, created_at: null })
    let options: { shouldPersist: () => boolean } | undefined
    vectorStore.indexTranscript.mockImplementation(async (_text: string, opts: typeof options) => { options = opts; return 1 })
    registerTranscriptsHandlers()
    await handlerFor('transcripts:reviewTiming')?.({} as never, { recordingId: 'rec-1', fingerprint, action: 'hide', findingId: 'odd_line:0-0' })
    expect(options).toBeDefined()
    db.queryOne.mockReturnValue({ full_text: 'good morning\nhow are you' })
    expect(options!.shouldPersist()).toBe(true)
    db.queryOne.mockReturnValue({ full_text: 'a newer save' })
    expect(options!.shouldPersist()).toBe(false)
  })

  it('writes nothing when the section transcription fails', async () => {
    transcribeRecordingSection.mockRejectedValue(new Error('Transcribing a section uses Gemini; add its key in Settings first'))
    registerTranscriptsHandlers()
    const result = await handlerFor('transcripts:retranscribeSection')?.({} as never, { recordingId: 'rec-1', fingerprint, findingId: 'odd_line:0-0' }) as any
    expect(result.success).toBe(false)
    expect(result.error.message).toMatch(/Gemini/)
    expect(db.runNoSave).not.toHaveBeenCalled()
  })
})
