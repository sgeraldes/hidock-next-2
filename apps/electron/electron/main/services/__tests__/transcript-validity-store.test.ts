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

import { initializeDatabase, closeDatabase, run, runNoSave, saveDatabase, queryOne, insertTranscript, getEligibleRecordingIds, isRecordingGraphIngestable, setTranscriptIntegrityAccepted, addToQueue, getQueueItems, updateQueueItem } from '../database'
import {
  backfillTranscriptValidity,
  refreshTranscriptValidity,
  previewTranscriptValidity,
  transcriptFingerprint,
} from '../transcript-validity-store'
import { autoLinkRecordingsToMeetings } from '../org-reconciler'
import { FRAME_SECONDS } from '../audio-profile'

const FILE_SECONDS = 600

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
    expect(getEligibleRecordingIds(['legacy-fulltext'], { forTextReformat: true }).eligible.has('legacy-fulltext')).toBe(true)
    run(`UPDATE recordings SET personal = 1 WHERE id = 'legacy-fulltext'`)
    expect(getEligibleRecordingIds(['legacy-fulltext'], { forTextReformat: true }).eligible.has('legacy-fulltext')).toBe(false)
    run(`UPDATE recordings SET personal = 0 WHERE id = 'legacy-fulltext'`)
  })
  it('persists explicit intent across failure, priority loss and database restart', async () => {
    seed('durable-request', [[160, 600]])
    const id = addToQueue('durable-request', undefined, true)
    updateQueueItem(id, 'failed', 'transient failure')
    refreshTranscriptValidity('durable-request')
    closeDatabase()
    await initializeDatabase()
    expect(getQueueItems('failed').find(q => q.id === id)?.explicit_request).toBe(1)
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
    seed('rec98', [[160, 600]])
    const lines = JSON.stringify([{ start: 0.9, end: 1010.8, text: 'one two three four five six seven eight nine' },
      { start: 1200, end: 1205, text: 'one two three four five six seven eight' }])
    run('UPDATE transcripts SET speakers = ?, word_count = 17 WHERE recording_id = ?', [lines, 'rec98'])
    run(`INSERT INTO processing_runs (id, recording_id, stage, provider, tool, execution, status, started_at, quality_json)
      VALUES ('vad-rec98', 'rec98', 'vad', 'hidock-next', 'vad', 'local', 'completed', '2026-10-04', ?)`,
      [JSON.stringify({ nonSilentSeconds: 598, durationSeconds: 1565 })])
    expect(refreshTranscriptValidity('rec98')?.status).toBe('incomplete')
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
    run(`UPDATE audio_profiles SET sound_seconds = 3971.015 WHERE recording_id = 'rec54'`)
    run(`UPDATE transcripts SET speakers = ?, summary = 'real summary', title_suggestion = 'real title',
      validity_version = 2, validity_status = 'valid' WHERE recording_id = 'rec54'`,
      [JSON.stringify([...Array.from({ length: 50 }, (_, i) => ({ start: i * 20, end: i * 20 + 19, text: 'real '.repeat(109) })), { start: 614, end: 1402, text: 'three real words' }])])
    run(`UPDATE recordings SET meeting_id = 'old-meeting', correlation_method = 'ai_transcript_match' WHERE id = 'rec54'`)
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
    expect(queryOne<{ meeting_id: string }>('SELECT meeting_id FROM recordings WHERE id = ?', ['rec54'])?.meeting_id).toBe('old-meeting')
    expect(getEligibleRecordingIds(['rec54']).eligible.has('rec54')).toBe(true)
    expect(queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', ['cap54'])?.quality_rating).toBe('unrated')
  })
  it('keeps incomplete verdicts without valid gap reasons excluded', () => {
    seed('unknown-incomplete', [[160, 600]])
    for (const json of ['{"reasons":[{"code":"sparse_speech"}]}', 'broken json']) {
      run(`UPDATE transcripts SET validity_status = 'incomplete', validity_json = ? WHERE recording_id = 'unknown-incomplete'`, [json])
      expect(getEligibleRecordingIds(['unknown-incomplete']).eligible.has('unknown-incomplete')).toBe(false)
      expect(isRecordingGraphIngestable('unknown-incomplete')).toBe(false)
    }
  })
  it('retracts Rec98 content rating, preserving audio and owner ratings', () => {
    for (const [id, source, method] of [['cap98', 'ai', 'content'], ['cap98audio', 'ai', 'audio'], ['cap98owner', 'user', 'content']]) {
      run(`INSERT INTO knowledge_captures (id, title, source_recording_id, quality_rating, quality_source, quality_method, captured_at)
        VALUES (?, 'title', 'rec98', 'garbage', ?, ?, '2026-10-04')`, [id, source, method])
    }
    refreshTranscriptValidity('rec98')
    expect(getEligibleRecordingIds(['rec98'], { forTranscription: true }).eligible.has('rec98')).toBe(false)
    expect(queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', ['cap98'])?.quality_rating).toBe('unrated')
    for (const id of ['cap98audio', 'cap98owner']) expect(queryOne<{ quality_rating: string }>('SELECT quality_rating FROM knowledge_captures WHERE id = ?', [id])?.quality_rating).toBe('garbage')
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

describe('full library projection', () => {
  it('drains 2140 stale rows despite clearing AI meeting links and checks zero next pass', async () => {
    await backfillTranscriptValidity()
    run(`INSERT INTO meetings (id,subject,start_time,end_time,attendees) VALUES ('projection-meeting','Sync','2026-10-05','2026-10-06','[{}]')`)
    for (let i = 0; i < 2140; i++) {
      const id = `projection-${String(i).padStart(4, '0')}`
      runNoSave(`INSERT INTO recordings (id,filename,date_recorded,meeting_id,correlation_method) VALUES (?,?,'2026-10-05','projection-meeting','ai_transcript_match')`, [id, `${id}.hda`])
      runNoSave(`INSERT INTO transcripts (id,recording_id,full_text,speakers,integrity_status,validity_version) VALUES (?,?, 'text','[]','broken',1)`, [`t-${id}`, id])
    }
    saveDatabase()
    let worstHoldMs = 0
    let last = performance.now()
    const heartbeat = setInterval(() => { const now = performance.now(); worstHoldMs = Math.max(worstHoldMs, now - last); last = now }, 0)
    const [first, concurrent] = await Promise.all([backfillTranscriptValidity(), backfillTranscriptValidity()])
    clearInterval(heartbeat)
    console.log(`2140-row projection worst hold: ${first.worstHoldMs}ms; heartbeat: ${worstHoldMs}ms`)
    writeFileSync(join(tmpdir(), 'f3-projection-hold.json'), JSON.stringify({ worstHoldMs: first.worstHoldMs, heartbeatMs: worstHoldMs }))
    expect(first.checked).toBe(2140)
    expect(concurrent.checked).toBe(0)
    expect(first.worstHoldMs).toBeLessThan(100)
    expect(worstHoldMs).toBeLessThan(100)
    expect(autoLinkRecordingsToMeetings()).toBe(0)
    expect((await backfillTranscriptValidity()).checked).toBe(0)
    expect(autoLinkRecordingsToMeetings()).toBe(0)
    expect((await backfillTranscriptValidity()).checked).toBe(0)
  }, 120000)
})

it('does not recreate automatic links contradicted by stored candidate evidence', () => {
  run(`INSERT INTO recordings (id,filename,date_recorded,duration_seconds) VALUES ('contradicted','contradicted.hda','2026-10-05',3600)`)
  run(`INSERT INTO recording_meeting_candidates (id,recording_id,meeting_id,confidence_score,is_selected) VALUES ('c-contradicted','contradicted','projection-meeting',0.2,0)`)
  expect(autoLinkRecordingsToMeetings()).toBe(0)
  expect(queryOne<{ meeting_id: string | null }>("SELECT meeting_id FROM recordings WHERE id = 'contradicted'")?.meeting_id).toBeNull()
})
