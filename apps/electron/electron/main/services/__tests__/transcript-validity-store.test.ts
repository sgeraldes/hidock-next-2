// @vitest-environment node

/**
 * The stored validity verdict against a real SQLite database and a real
 * envelope file: text over frames with no audio is invalid, the library pass
 * checks each transcript once, and a meeting linked later (a new invite count)
 * has it checked again.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '', cache: '' }))
paths.db = join(tmpdir(), `hidock-validity-store-${process.pid}-${Date.now()}.db`)
paths.cache = join(tmpdir(), `hidock-validity-cache-${process.pid}-${Date.now()}`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
  getCachePath: () => paths.cache,
  getTranscriptsPath: () => join(paths.cache, 'transcripts'),
}))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { valueClassificationMinConfidence: 0.6 } }),
}))
const emitDomainEvent = vi.hoisted(() => vi.fn())
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent }) }))

import { initializeDatabase, closeDatabase, run, queryOne, insertTranscript, getEligibleRecordingIds, getFailedTranscriptsForReanalysis, isRecordingGraphIngestable, setTranscriptIntegrityAccepted, addToQueue, getQueueItems, updateQueueItem } from '../database'
import {
  backfillTranscriptValidity,
  refreshTranscriptValidity,
  previewTranscriptValidity,
  readSpeechEvidence,
  transcriptFingerprint,
} from '../transcript-validity-store'
import { storeDiarizedSegments } from '../diarization-store'
import { autoLinkRecordingsToMeetings } from '../org-reconciler'
import { filterTextReformatEligibleRecordingIds } from '../recording-eligibility'
import { FRAME_SECONDS } from '../audio-profile'

const FILE_SECONDS = 600

/** Rec98's shape: 17 words over 598 s of VAD speech, one 17-minute line with 9 of them. */
function seedRec98(id: string): string {
  seed(id, [[160, 600]])
  const lines = JSON.stringify([{ start: 0.9, end: 1010.8, text: 'one two three four five six seven eight nine' },
    { start: 1200, end: 1205, text: 'one two three four five six seven eight' }])
  run('UPDATE transcripts SET speakers = ?, word_count = 17 WHERE recording_id = ?', [lines, id])
  run(`INSERT INTO processing_runs (id, recording_id, stage, provider, tool, execution, status, started_at, quality_json)
    VALUES (?, ?, 'vad', 'hidock-next', 'vad', 'local', 'completed', '2026-10-04', ?)`,
    [`vad-${id}`, id, JSON.stringify({ nonSilentSeconds: 598, durationSeconds: 1565 })])
  return lines
}

function seed(id: string, gains: Array<[number, number]>): void {
  run(
    `INSERT INTO recordings (id, filename, file_path, duration_seconds, duration_source, date_recorded, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal)
     VALUES (?, ?, NULL, ?, 'file', '2026-04-21T11:57:18.000Z', 'complete', 'local-only', 'complete', 0, 1, 'hidock', 0, 0)`,
    [id, `2026Apr21-115718-${id}.hda`, FILE_SECONDS]
  )
  run(
    `INSERT INTO audio_profiles (recording_id, version, method, file_size, file_mtime_ms, duration_seconds, sound_seconds,
        sound_share, longest_sound_seconds, median_level, spike_count, category, ranges_json, computed_at)
     VALUES (?, 1, 'mp3-frame-gain', 1, 1, ?, 600, 1, 600, 160, 0, 'speech', '[]', '2026-09-25T23:29:04.713Z')`,
    [id, FILE_SECONDS]
  )
  const frames: number[] = []
  for (const [gain, seconds] of gains) for (let i = 0; i < Math.round(seconds / FRAME_SECONDS); i++) frames.push(gain)
  mkdirSync(join(paths.cache, 'audio-envelope'), { recursive: true })
  writeFileSync(join(paths.cache, 'audio-envelope', `${id}.u8`), Uint8Array.from(frames))
  const segments = Array.from({ length: 50 }, (_, i) => ({
    speaker: i % 2 ? 'A' : 'B',
    start: i * 11,
    end: i * 11 + 10,
    text: Array.from({ length: 20 }, (_, w) => `w${w}-${i}`).join(' '),
  }))
  insertTranscript({
    id: `trans_${id}`,
    recording_id: id,
    full_text: segments.map((s) => s.text).join(' '),
    language: 'es',
    speakers: JSON.stringify(segments),
    word_count: 1000,
  })
}

const stored = (id: string) =>
  queryOne<{ validity_status: string | null; validity_json: string | null; validity_version: number | null }>(
    'SELECT validity_status, validity_json, validity_version FROM transcripts WHERE recording_id = ?',
    [id]
  )

beforeAll(async () => {
  await initializeDatabase()
})

afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
  if (existsSync(paths.cache)) rmSync(paths.cache, { recursive: true, force: true })
})

describe('transcript validity store', () => {
  it('reads the envelope: text over frames with no audio is invalid, text over speech valid', async () => {
    seed('quiet', [[138, 590], [160, 10]])
    seed('talk', [[160, 600]])
    const counts = await backfillTranscriptValidity()
    expect(counts).toMatchObject({ checked: 2, invalid: 1, valid: 1 })
    expect(counts.changedIds).toEqual(['quiet', 'talk'])
    expect(emitDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'transcript:verdicts-updated', payload: { recordingIds: ['quiet', 'talk'], metadataChangedIds: ['quiet'] } }))
    expect(stored('quiet')?.validity_status).toBe('invalid')
    expect(JSON.parse(stored('quiet')!.validity_json!).reasons.map((r: { code: string }) => r.code)).toContain('text_without_audio')
    expect(stored('talk')?.validity_status).toBe('valid')
  })

  it('does not report other work that ran during its own yield as a hold', async () => {
    seed('yield-a', [[160, 600]])
    seed('yield-b', [[160, 600]])
    const warn = vi.spyOn(console, 'warn')
    // Another task takes the main thread for 150 ms while the pass yields.
    const busy = setTimeout(() => { const end = performance.now() + 150; while (performance.now() < end) { /* busy */ } }, 0)
    try {
      await backfillTranscriptValidity({ batchSize: 1 })
      expect(warn.mock.calls.filter(([message]) => String(message).includes('held the main thread'))).toEqual([])
    } finally { clearTimeout(busy); warn.mockRestore() }
  })

  it('checks each transcript once', async () => {
    expect(await backfillTranscriptValidity()).toEqual({ checked: 0, changedIds: [] })
  })

  it('checks again when a meeting is linked later and the speakers outnumber its invitees', async () => {
    run(`INSERT INTO meetings (id, subject, start_time, end_time, attendees) VALUES ('m1', 'Sync', '2026-04-21T11:00:00Z', '2026-04-21T12:00:00Z', ?)`, [
      JSON.stringify([{ email: 'a@x.com' }]),
    ])
    run(`UPDATE recordings SET meeting_id = 'm1' WHERE id = 'talk'`)
    // Two speakers against one invitee is still within "invitees plus one".
    expect(await backfillTranscriptValidity()).toMatchObject({ checked: 1, valid: 1, changedIds: [] })
    expect(JSON.parse(stored('talk')!.validity_json!).measures.attendees).toBe(1)
    expect(await backfillTranscriptValidity()).toEqual({ checked: 0, changedIds: [] })
  })

  it('refreshes one recording, and previews lines not stored yet', () => {
    expect(refreshTranscriptValidity('talk')?.status).toBe('valid')
    expect(refreshTranscriptValidity('no-such-recording')).toBeNull()
    const lines = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ speaker: 'A', start: i * 11, end: i * 11 + 10, text: 'x '.repeat(20) })))
    expect(previewTranscriptValidity('quiet', lines)?.status).toBe('invalid')
    expect(previewTranscriptValidity('quiet', lines, { integrityStatus: 'broken' })?.reasons[0].code).toBe('integrity')
  })
})

describe('follow-up regressions', () => {
  it('withholds machine metadata reversibly and preserves owner summaries on acceptance', () => {
    seed('reversible', [[160, 600]])
    run(`INSERT INTO meetings (id,subject,start_time,end_time) VALUES ('reversible-meeting','Sync','2026-10-05','2026-10-06')`)
    run(`UPDATE recordings SET meeting_id = 'reversible-meeting', correlation_method = 'ai_transcript_match' WHERE id = 'reversible'`)
    run(`INSERT INTO recording_meeting_candidates (id,recording_id,meeting_id,is_selected,is_ai_selected) VALUES ('reversible-candidate','reversible','reversible-meeting',1,1)`)
    run(`UPDATE transcripts SET speakers = '[{"start":0,"end":600,"text":"hello"}]', summary = 'machine summary', title_suggestion = 'machine title' WHERE recording_id = 'reversible'`)
    run(`INSERT INTO knowledge_captures (id,title,summary,source_recording_id,captured_at) VALUES ('owner-summary','owner title','owner edited','reversible','2026-10-05')`)
    run(`INSERT INTO knowledge_captures (id,title,summary,summary_source,source_recording_id,captured_at) VALUES ('machine-summary','title','machine capture summary','ai','reversible','2026-10-05')`)
    run(`INSERT INTO knowledge_captures (id,title,summary,summary_source,source_recording_id,captured_at) VALUES ('edited-while-held','title','old AI summary','ai','reversible','2026-10-05')`)
    refreshTranscriptValidity('reversible')
    expect(queryOne('SELECT summary FROM knowledge_captures WHERE id = ?', ['owner-summary'])).toEqual({ summary: 'owner edited' })
    expect(queryOne('SELECT summary FROM transcripts WHERE recording_id = ?', ['reversible'])).toEqual({ summary: null })
    expect(queryOne('SELECT summary FROM knowledge_captures WHERE id = ?', ['machine-summary'])).toEqual({ summary: null })
    expect(queryOne('SELECT is_selected FROM recording_meeting_candidates WHERE id = ?', ['reversible-candidate'])).toEqual({ is_selected: 0 })
    refreshTranscriptValidity('reversible') // Rechecking must not overwrite the original snapshot with NULLs.
    run(`UPDATE knowledge_captures SET summary = 'new owner summary', summary_source = 'user' WHERE id = 'edited-while-held'`)
    setTranscriptIntegrityAccepted('reversible', true)
    refreshTranscriptValidity('reversible')
    expect(queryOne('SELECT summary, title_suggestion FROM transcripts WHERE recording_id = ?', ['reversible'])).toEqual({ summary: 'machine summary', title_suggestion: 'machine title' })
    expect(queryOne('SELECT summary FROM knowledge_captures WHERE id = ?', ['machine-summary'])).toEqual({ summary: 'machine capture summary' })
    expect(queryOne('SELECT summary FROM knowledge_captures WHERE id = ?', ['edited-while-held'])).toEqual({ summary: 'new owner summary' })
    expect(queryOne('SELECT meeting_id FROM recordings WHERE id = ?', ['reversible'])).toEqual({ meeting_id: 'reversible-meeting' })
    expect(queryOne('SELECT is_selected FROM recording_meeting_candidates WHERE id = ?', ['reversible-candidate'])).toEqual({ is_selected: 1 })
  })
  it('uses full_text for legacy rows without speakers and keeps their metadata', () => {
    seed('legacy-fulltext', [[160, 600]])
    run(`UPDATE transcripts SET speakers = NULL, full_text = ?, summary = 'preserved' WHERE recording_id = 'legacy-fulltext'`, ['word '.repeat(3087)])
    expect(refreshTranscriptValidity('legacy-fulltext')?.measures.words).toBe(3087)
    expect(queryOne('SELECT summary FROM transcripts WHERE recording_id = ?', ['legacy-fulltext'])).toEqual({ summary: 'preserved' })
    expect(filterTextReformatEligibleRecordingIds(['legacy-fulltext']).eligible.has('legacy-fulltext')).toBe(true)
    run(`UPDATE recordings SET personal = 1 WHERE id = 'legacy-fulltext'`)
    expect(filterTextReformatEligibleRecordingIds(['legacy-fulltext']).eligible.has('legacy-fulltext')).toBe(false)
    run(`UPDATE recordings SET personal = 0 WHERE id = 'legacy-fulltext'`)
  })
  it('persists the owner request across failure, priority loss and database restart', async () => {
    seed('durable-request', [[160, 600]])
    const id = addToQueue('durable-request', undefined, { ownerRequested: true })
    updateQueueItem(id, 'failed', 'transient failure')
    refreshTranscriptValidity('durable-request')
    closeDatabase()
    await initializeDatabase()
    expect(getQueueItems('failed').find(q => q.id === id)?.owner_requested).toBe(true)
  })
})

describe('a sample of the audio', () => {
  it('checks historical sparse and empty transcripts without a VAD ledger using the stored speech activity profile', () => {
    seed('historical-sparse', [[160, 600]])
    run(`UPDATE transcripts SET speakers = '[{"start":0,"end":10,"text":"hello"}]', full_text = 'hello', word_count = 1
      WHERE recording_id = 'historical-sparse'`)
    expect(refreshTranscriptValidity('historical-sparse')?.status).toBe('incomplete')
    run(`UPDATE transcripts SET speakers = '[]', full_text = '', word_count = 0 WHERE recording_id = 'historical-sparse'`)
    expect(refreshTranscriptValidity('historical-sparse')?.status).toBe('incomplete')
  })
  it('uses independent VAD evidence for a sparse stored transcript and a fresh preview', () => {
    const lines = seedRec98('rec98')
    expect(refreshTranscriptValidity('rec98')?.status).toBe('incomplete')
    // The stored verdict read the VAD ledger (598 s), not the 600 s profile fallback.
    expect(JSON.parse(stored('rec98')!.validity_json!).measures.detectedSpeechSeconds).toBe(598)
    expect(previewTranscriptValidity('rec98', lines, { vadSpeechSeconds: 598,
      diarizedSegments: [{ start: 0, end: 1057 }] })?.measures.detectedSpeechSeconds).toBe(1057)
    expect(stored('rec98')?.validity_status).toBe('incomplete')
  })
  it('rechecks v1 verdicts and retracts derived metadata, preserving text and owner links', async () => {
    seed('old-sparse', [[160, 600]])
    run(`INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('old-meeting', 'Meeting', '2026-10-04', '2026-10-05')`)
    run(`UPDATE recordings SET meeting_id = 'old-meeting', correlation_method = 'ai_transcript_match' WHERE id = 'old-sparse'`)
    run(`UPDATE transcripts SET speakers = ?, full_text = 'keep original', word_count = 17,
      summary = 'bad summary', title_suggestion = 'bad title', validity_status = 'valid', validity_version = 1,
      validity_json = '{"measures":{"attendees":0}}' WHERE recording_id = 'old-sparse'`,
      [JSON.stringify([{ start: 0, end: 600, text: 'word '.repeat(17) }])])
    run(`INSERT INTO processing_runs (id, recording_id, stage, provider, tool, execution, status, started_at, quality_json)
      VALUES ('old-vad', 'old-sparse', 'vad', 'hidock-next', 'vad', 'local', 'completed', '2026-10-04', '{"nonSilentSeconds":598}')`)
    const wikiDir = join(paths.cache, 'transcripts', 'wiki')
    mkdirSync(wikiDir, { recursive: true })
    const ownedWiki = join(wikiDir, 'old-sparse.md')
    const otherWiki = join(wikiDir, 'unrelated.md')
    writeFileSync(ownedWiki, '---\ngenerator: hidock-meeting-wiki\nwiki_schema: 1\nrecording_id: old-sparse\n---\nBad summary\n')
    writeFileSync(otherWiki, 'An unrelated document')
    await backfillTranscriptValidity()
    expect(stored('old-sparse')).toMatchObject({ validity_status: 'incomplete', validity_version: 5 })
    expect(queryOne('SELECT full_text, summary, title_suggestion FROM transcripts WHERE recording_id = ?', ['old-sparse']))
      .toEqual({ full_text: 'keep original', summary: null, title_suggestion: null })
    expect(queryOne<{ meeting_id: string | null }>('SELECT meeting_id FROM recordings WHERE id = ?', ['old-sparse'])?.meeting_id).toBeNull()
    expect(existsSync(ownedWiki)).toBe(false)
    expect(existsSync(otherWiki)).toBe(true)
    expect(getEligibleRecordingIds(['old-sparse']).eligible.has('old-sparse')).toBe(false)
    expect(getEligibleRecordingIds(['old-sparse'], { forTranscription: true }).eligible.has('old-sparse')).toBe(true)
    run(`UPDATE recordings SET meeting_id = 'old-meeting', correlation_method = 'manual' WHERE id = 'old-sparse'`)
    refreshTranscriptValidity('old-sparse')
    expect(queryOne<{ meeting_id: string | null }>('SELECT meeting_id FROM recordings WHERE id = ?', ['old-sparse'])?.meeting_id).toBe('old-meeting')
  })
  it('keeps Rec54 gap-only metadata and eligibility while retracting text ratings', async () => {
    seed('rec54', [[160, 1600]])
    run(`INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('rec54-meeting', 'Meeting', '2026-10-04', '2026-10-05')`)
    mkdirSync(join(paths.cache, 'transcripts', 'wiki'), { recursive: true })
    run(`UPDATE audio_profiles SET sound_seconds = 3971.015 WHERE recording_id = 'rec54'`)
    run(`UPDATE transcripts SET speakers = ?, summary = 'real summary', title_suggestion = 'real title',
      validity_version = 2, validity_status = 'valid' WHERE recording_id = 'rec54'`,
      [JSON.stringify([...Array.from({ length: 50 }, (_, i) => ({ start: i * 20, end: i * 20 + 19, text: 'real '.repeat(109) })), { start: 614, end: 1402, text: 'three real words' }])])
    run(`UPDATE recordings SET meeting_id = 'rec54-meeting', correlation_method = 'ai_transcript_match' WHERE id = 'rec54'`)
    run(`INSERT INTO knowledge_captures (id, title, source_recording_id, quality_rating, quality_source, quality_method, captured_at)
      VALUES ('cap54', 'real title', 'rec54', 'garbage', 'ai', 'content', '2026-10-04')`)
    const wikiPath = join(paths.cache, 'transcripts', 'wiki', 'rec54.md')
    writeFileSync(wikiPath, '---\ngenerator: hidock-meeting-wiki\nwiki_schema: 1\nrecording_id: rec54\n---\nReal content\n')
    await backfillTranscriptValidity()
    expect(existsSync(wikiPath)).toBe(true)
    expect(isRecordingGraphIngestable('rec54')).toBe(true)
    expect(stored('rec54')?.validity_status).toBe('incomplete')
    expect(JSON.parse(stored('rec54')!.validity_json!).reasons[0].detail).toBe('10:14 to 23:22 has 3 words.')
    expect(queryOne('SELECT summary, title_suggestion FROM transcripts WHERE recording_id = ?', ['rec54']))
      .toEqual({ summary: 'real summary', title_suggestion: 'real title' })
    expect(queryOne<{ meeting_id: string }>('SELECT meeting_id FROM recordings WHERE id = ?', ['rec54'])?.meeting_id).toBe('rec54-meeting')
    expect(getEligibleRecordingIds(['rec54']).eligible.has('rec54')).toBe(true)
    expect(queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', ['cap54'])?.quality_rating).toBe('unrated')
  })
  it('excludes broken text whatever the verdict, and incomplete verdicts whose reasons are not an array', () => {
    seed('broken-audio', [[160, 600]])
    run(`UPDATE transcripts SET integrity_status = 'broken', integrity_accepted_at = NULL, validity_status = 'audio' WHERE recording_id = 'broken-audio'`)
    expect(getEligibleRecordingIds(['broken-audio']).eligible.has('broken-audio')).toBe(false)
    expect(isRecordingGraphIngestable('broken-audio')).toBe(false)
    run(`UPDATE transcripts SET integrity_accepted_at = '2026-11-24' WHERE recording_id = 'broken-audio'`)
    expect(getEligibleRecordingIds(['broken-audio']).eligible.has('broken-audio')).toBe(true)
    seed('shapeless', [[160, 600]])
    for (const json of ['{}', '{"reasons":null}', '{"reasons":"sparse_speech"}']) {
      run(`UPDATE transcripts SET validity_status = 'incomplete', validity_json = ? WHERE recording_id = 'shapeless'`, [json])
      expect(getEligibleRecordingIds(['shapeless']).eligible.has('shapeless')).toBe(false)
      expect(isRecordingGraphIngestable('shapeless')).toBe(false)
    }
    run(`UPDATE transcripts SET validity_json = '{"reasons":[{"code":"sparse_long_segment"}]}' WHERE recording_id = 'shapeless'`)
    expect(getEligibleRecordingIds(['shapeless']).eligible.has('shapeless')).toBe(true)
  })
  it('counts the incoming text in a preview of a result without timed lines (review of #173)', () => {
    seed('preview-text', [[160, 600]])
    const fresh = previewTranscriptValidity('preview-text', '[]', { fullText: 'word '.repeat(600), vadSpeechSeconds: 600 })
    expect(fresh?.measures.words).toBe(600)
    expect(fresh?.reasons.map((r) => r.code)).not.toContain('sparse_speech')
    // A genuinely empty answer still counts as zero words.
    expect(previewTranscriptValidity('preview-text', '[]', { fullText: '', vadSpeechSeconds: 600 })?.reasons.map((r) => r.code)).toContain('sparse_speech')
  })

  it('gives the stored assessment the VAD activity the fresh one had (review of #173)', () => {
    seed('stored-activity', [[160, 600]])
    run('UPDATE transcripts SET speakers = ? WHERE recording_id = ?', [JSON.stringify([
      { start: 0, end: 300, text: 'one two three four five six seven eight nine ten eleven twelve' },
      { start: 300, end: 360, text: 'word '.repeat(150) }]), 'stored-activity'])
    run(`INSERT INTO processing_runs (id, recording_id, stage, provider, tool, execution, status, started_at, quality_json)
      VALUES ('vad-stored-activity', 'stored-activity', 'vad', 'hidock-next', 'vad', 'local', 'completed', '2026-11-24', ?)`,
      [JSON.stringify({ nonSilentSeconds: 65, durationSeconds: 600, activityIntervals: [{ start: 0, end: 5 }, { start: 300, end: 360 }] })])
    expect(readSpeechEvidence('stored-activity').activityIntervals).toEqual([{ start: 0, end: 5 }, { start: 300, end: 360 }])
    expect(refreshTranscriptValidity('stored-activity')?.reasons.map((r) => r.code)).not.toContain('sparse_long_segment')
  })

  it('reads the acoustic turns stored under the acoustic run, which the transcript does not reference', () => {
    seed('acoustic-run', [[160, 600]])
    run(`INSERT INTO processing_runs (id, recording_id, stage, provider, tool, execution, status, started_at)
      VALUES ('acoustic-run-1', 'acoustic-run', 'diarization', 'pyannote', 'pyannote', 'local', 'completed', '2026-11-24')`)
    storeDiarizedSegments('acoustic-run', 'acoustic-run-1', [{ start: 0, end: 120, speaker: 'A' }, { start: 130, end: 300, speaker: 'B' }])
    expect(readSpeechEvidence('acoustic-run').diarizedSegments).toEqual([{ start: 0, end: 120 }, { start: 130, end: 300 }])
  })

  it('withholds and notifies when a gap-only transcript turns sparse and stays incomplete', async () => {
    seed('gap-to-sparse', [[160, 600]])
    const gapOnly = JSON.stringify({ status: 'incomplete', reasons: [{ code: 'sparse_long_segment', detail: '' }] })
    run(`UPDATE transcripts SET speakers = ?, full_text = 'only three words', word_count = 3, summary = 'kept while gap-only',
        validity_status = 'incomplete', validity_json = ?, validity_version = 1 WHERE recording_id = 'gap-to-sparse'`,
      [JSON.stringify([{ speaker: 'A', start: 0, end: 590, text: 'only three words' }]), gapOnly])
    emitDomainEvent.mockClear()
    await backfillTranscriptValidity()
    expect(stored('gap-to-sparse')?.validity_status).toBe('incomplete')
    expect(queryOne('SELECT summary FROM transcripts WHERE recording_id = ?', ['gap-to-sparse'])).toEqual({ summary: null })
    const event = emitDomainEvent.mock.calls.map(([e]) => e).find((e) => e.type === 'transcript:verdicts-updated')
    expect(event?.payload.metadataChangedIds).toContain('gap-to-sparse')
    expect(event?.payload.recordingIds).toContain('gap-to-sparse')
  })

  it('judges the verdict again when restoring the AI meeting link changes the invite count', () => {
    seed('restore-attendees', [[160, 600]])
    run(`INSERT INTO meetings (id, subject, start_time, end_time, attendees) VALUES ('one-invitee', 'Sync', '2026-04-21', '2026-04-22', ?)`,
      [JSON.stringify([{ email: 'a@example.com' }])])
    const lines = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ speaker: `Voice ${i % 4}`, start: i * 10, end: i * 10 + 9, text: `w ${i} `.repeat(15) })))
    run('UPDATE transcripts SET speakers = ?, full_text = ? WHERE recording_id = ?', [lines, 'w '.repeat(900), 'restore-attendees'])
    run(`INSERT INTO transcript_withheld_metadata (recording_id, transcript_fingerprint, values_json, withheld_at, validity_version) VALUES (?, ?, ?, '2026-10-04', 4)`,
      ['restore-attendees', transcriptFingerprint(JSON.stringify([lines, 'w '.repeat(900)])),
        JSON.stringify({ transcript: {}, captures: [], recording: { meeting_id: 'one-invitee', correlation_confidence: 0.9, correlation_method: 'ai_transcript_match' } })])
    const verdict = refreshTranscriptValidity('restore-attendees')
    expect(queryOne('SELECT meeting_id FROM recordings WHERE id = ?', ['restore-attendees'])).toEqual({ meeting_id: 'one-invitee' })
    // Four voices for one invitee: the speaker doubt the restored link brings is in the stored verdict.
    expect(verdict?.measures.attendees).toBe(1)
    expect(verdict?.reasons.map((r) => r.code)).toContain('more_speakers_than_invited')
    expect(JSON.parse(stored('restore-attendees')!.validity_json!).measures.attendees).toBe(1)
  })

  it('rolls the verdict back with its side effects when withholding fails', () => {
    seed('atomic-verdict', [[160, 600]])
    run(`UPDATE transcripts SET speakers = ?, full_text = 'only three words', word_count = 3, summary = 'still here', validity_version = 1
        WHERE recording_id = 'atomic-verdict'`, [JSON.stringify([{ speaker: 'A', start: 0, end: 590, text: 'only three words' }])])
    run('ALTER TABLE transcript_withheld_metadata RENAME TO transcript_withheld_metadata_hidden')
    try {
      expect(() => refreshTranscriptValidity('atomic-verdict')).toThrow()
    } finally {
      run('ALTER TABLE transcript_withheld_metadata_hidden RENAME TO transcript_withheld_metadata')
    }
    expect(queryOne('SELECT summary, validity_version FROM transcripts WHERE recording_id = ?', ['atomic-verdict'])).toEqual({ summary: 'still here', validity_version: 1 })
  })

  it('drops a snapshot that a usable replacement transcript supersedes', () => {
    seed('superseded', [[160, 600]])
    run(`INSERT INTO transcript_withheld_metadata (recording_id, transcript_fingerprint, values_json, withheld_at, validity_version)
      VALUES ('superseded', 'an-older-transcript', '{"transcript":{"summary":"old"},"captures":[]}', '2026-10-04', 4)`)
    expect(refreshTranscriptValidity('superseded')?.status).toBe('valid')
    expect(queryOne('SELECT 1 AS x FROM transcript_withheld_metadata WHERE recording_id = ?', ['superseded'])).toBeUndefined()
    expect(queryOne('SELECT summary FROM transcripts WHERE recording_id = ?', ['superseded'])).not.toEqual({ summary: 'old' })
  })

  it('offers doubtful and gap-only transcripts a summary, never sparse or invalid ones (review of #173)', async () => {
    const cases: Array<[string, string, string]> = [
      ['sum-doubt', 'doubtful', '{"reasons":[{"code":"no_times"}]}'],
      ['sum-gap', 'incomplete', '{"reasons":[{"code":"sparse_long_segment"}]}'],
      ['sum-sparse', 'incomplete', '{"reasons":[{"code":"sparse_speech"}]}'],
      ['sum-invalid', 'invalid', '{"reasons":[]}'],
    ]
    for (const [id, status, json] of cases) {
      seed(id, [[160, 600]])
      run(`UPDATE transcripts SET summary = NULL, validity_status = ?, validity_json = ?, validity_version = 99 WHERE recording_id = ?`, [status, json, id])
    }
    const offered = new Set((await getFailedTranscriptsForReanalysis(-1)).map((row) => row.recording_id))
    expect(offered.has('sum-doubt')).toBe(true)
    expect(offered.has('sum-gap')).toBe(true)
    expect(offered.has('sum-sparse')).toBe(false)
    expect(offered.has('sum-invalid')).toBe(false)
  })

  it('keeps incomplete verdicts without valid gap reasons excluded', () => {
    seed('unknown-incomplete', [[160, 600]])
    // NULL too (review of #173): json_valid(NULL) is NULL, which NOT alone would let through.
    for (const json of ['{"reasons":[{"code":"sparse_speech"}]}', 'broken json', null]) {
      run(`UPDATE transcripts SET validity_status = 'incomplete', validity_json = ? WHERE recording_id = 'unknown-incomplete'`, [json])
      expect(getEligibleRecordingIds(['unknown-incomplete']).eligible.has('unknown-incomplete')).toBe(false)
      expect(isRecordingGraphIngestable('unknown-incomplete')).toBe(false)
    }
  })
  it('retracts Rec98 content rating, preserving audio and owner ratings', () => {
    seedRec98('rec98-ratings')
    for (const [id, source, method] of [['cap98', 'ai', 'content'], ['cap98audio', 'ai', 'audio'], ['cap98owner', 'user', 'content']]) {
      run(`INSERT INTO knowledge_captures (id, title, source_recording_id, quality_rating, quality_source, quality_method, captured_at)
        VALUES (?, 'title', 'rec98-ratings', 'garbage', ?, ?, '2026-10-04')`, [id, source, method])
    }
    refreshTranscriptValidity('rec98-ratings')
    expect(getEligibleRecordingIds(['rec98-ratings'], { forTranscription: true }).eligible.has('rec98-ratings')).toBe(false)
    expect(queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', ['cap98'])?.quality_rating).toBe('unrated')
    for (const id of ['cap98audio', 'cap98owner']) expect(queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', [id])?.quality_rating).toBe('garbage')
  })
  it('keeps the withheld originals when a speaker is renamed on a still-withheld transcript', () => {
    seed('rename-sparse', [[160, 600]])
    const sparse = (label: string) => JSON.stringify([{ speaker: label, start: 0, end: 590, text: 'only three words' }])
    run(`UPDATE transcripts SET speakers = ?, full_text = 'only three words', word_count = 3, summary = 'original summary' WHERE recording_id = 'rename-sparse'`, [sparse('A')])
    expect(refreshTranscriptValidity('rename-sparse')?.reasons.map((r) => r.code)).toContain('sparse_speech')
    expect(queryOne('SELECT summary FROM transcripts WHERE recording_id = ?', ['rename-sparse'])).toEqual({ summary: null })
    run('UPDATE transcripts SET speakers = ? WHERE recording_id = ?', [sparse('Laura'), 'rename-sparse'])
    refreshTranscriptValidity('rename-sparse')
    const saved = queryOne<{ values_json: string; transcript_fingerprint: string }>('SELECT values_json, transcript_fingerprint FROM transcript_withheld_metadata WHERE recording_id = ?', ['rename-sparse'])!
    expect(JSON.parse(saved.values_json).transcript.summary).toBe('original summary')
    expect(saved.transcript_fingerprint).toBe(transcriptFingerprint(JSON.stringify([sparse('Laura'), 'only three words'])))
  })
  it('restores formerly withheld doubtful metadata on the next backfill', async () => {
    seed('restore-doubt', [[160, 600]])
    run(`UPDATE transcripts SET summary = NULL, title_suggestion = NULL, speakers = '[]', full_text = ?, word_count = 1000, validity_status = 'doubtful', validity_version = 1 WHERE recording_id = 'restore-doubt'`, ['real '.repeat(1000)])
    const fingerprint = transcriptFingerprint(JSON.stringify(['[]', 'real '.repeat(1000)]))
    run(`INSERT INTO transcript_withheld_metadata (recording_id, transcript_fingerprint, values_json, withheld_at, validity_version) VALUES ('restore-doubt', ?, ?, '2026-10-04', 4)`,
      [fingerprint, JSON.stringify({ transcript: { summary: 'saved summary', title_suggestion: 'saved title' }, captures: [] })])
    const restored = await backfillTranscriptValidity()
    expect(restored.changedIds).toContain('restore-doubt')
    expect(stored('restore-doubt')?.validity_status).toBe('doubtful')
    expect(queryOne('SELECT summary, title_suggestion FROM transcripts WHERE recording_id = ?', ['restore-doubt'])).toEqual({ summary: 'saved summary', title_suggestion: 'saved title' })
    expect(getEligibleRecordingIds(['restore-doubt']).eligible.has('restore-doubt')).toBe(true)
    expect(isRecordingGraphIngestable('restore-doubt')).toBe(true)
  })
  it('settles a doubtful transcript only while it is the transcript that was sampled', () => {
    seed('doubt', [[160, 600]])
    const lines = Array.from({ length: 20 }, (_, i) => ({ speaker: 'A', start: Math.floor(i / 2) * 60, end: Math.floor(i / 2) * 60 + 50, text: `w ${i} `.repeat(10) }))
    run('UPDATE transcripts SET speakers = ? WHERE recording_id = ?', [JSON.stringify(lines), 'doubt'])
    expect(refreshTranscriptValidity('doubt')?.status).toBe('doubtful')

    const speakers = queryOne<{ speakers: string }>('SELECT speakers FROM transcripts WHERE recording_id = ?', ['doubt'])!.speakers
    run(
      `INSERT INTO transcript_samples (recording_id, transcript_fingerprint, verdict, windows_json, model, cost_usd, sampled_at)
       VALUES ('doubt', ?, 'confirmed', '[]', 'gemini-3.5-transcribe', 0.0102, '2026-10-04T12:00:00Z')`,
      [transcriptFingerprint(speakers)]
    )
    expect(refreshTranscriptValidity('doubt')?.status).toBe('valid')

    // A new transcript is not the one sampled: the doubt comes back.
    run('UPDATE transcripts SET speakers = ? WHERE recording_id = ?', [JSON.stringify(lines.slice(1)), 'doubt'])
    expect(refreshTranscriptValidity('doubt')?.status).toBe('doubtful')
  })
})

it('does not recreate automatic links contradicted by stored candidate evidence', () => {
  // Its own tightly matching meeting, and a control that differs only by the candidate row.
  run(`INSERT INTO meetings (id,subject,start_time,end_time) VALUES ('contradicted-meeting','Sync','2027-01-05T10:00:00Z','2027-01-05T11:00:00Z')`)
  for (const id of ['contradicted', 'contradicted-control']) {
    run(`INSERT INTO recordings (id,filename,date_recorded,duration_seconds) VALUES (?, ?, '2027-01-05T10:00:00Z', 3600)`, [id, `${id}.hda`])
  }
  run(`INSERT INTO recording_meeting_candidates (id,recording_id,meeting_id,confidence_score,is_selected) VALUES ('c-contradicted','contradicted','contradicted-meeting',0.2,0)`)
  autoLinkRecordingsToMeetings()
  expect(queryOne<{ meeting_id: string | null }>("SELECT meeting_id FROM recordings WHERE id = 'contradicted-control'")?.meeting_id).toBe('contradicted-meeting')
  expect(queryOne<{ meeting_id: string | null }>("SELECT meeting_id FROM recordings WHERE id = 'contradicted'")?.meeting_id).toBeNull()
})
