// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const paths = vi.hoisted(() => ({ root: '', db: '', audio: '' }))
paths.root = mkdtempSync(join(tmpdir(), 'hidock-quality-review-'))
paths.db = join(paths.root, 'review.db'); paths.audio = join(paths.root, 'source.ogg')
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getCachePath: () => paths.root }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: { modelHostUrl: '', modelHostToken: '' } }) }))
vi.mock('../model-host-client', () => ({ checkModelHost: vi.fn() }))
const decide = vi.hoisted(() => vi.fn())
vi.mock('../quality-repair-advice', async importOriginal => ({
  ...await importOriginal<typeof import('../quality-repair-advice')>(), requestRepairAdvice: decide
}))
import { initializeDatabase, closeDatabase, run, queryOne } from '../database'
import { confirmRepairParticipation, repairEvidenceFor, getRepairContext, getRepairAdvice } from '../quality-repair-service'

beforeAll(async () => {
  writeFileSync(paths.audio, Buffer.from('immutable audio source fixture'))
  await initializeDatabase()
  run(`INSERT INTO recordings (id, filename, file_path, duration_seconds, date_recorded, transcription_status)
    VALUES ('review-recording', 'source.ogg', ?, 120, '2026-10-08', 'complete')`, [paths.audio])
  run(`INSERT INTO transcripts (id, recording_id, full_text, speakers, validity_status, validity_json)
    VALUES ('review-transcript', 'review-recording', 'Words must remain unchanged', ?, 'doubtful', ?)`,
    [JSON.stringify([{ speaker: 'Voice A', start: 1, end: 8, text: 'A question' },
      { speaker: 'Voice B', start: 9, end: 16, text: 'An answer' }]),
    JSON.stringify({ reasons: [{ code: 'more_speakers_than_invited', detail: 'Extra labels' }] })])
})
afterAll(() => { closeDatabase(); rmSync(paths.root, { recursive: true, force: true }) })

describe('persisted repair evidence and intent', () => {
  it('does not manufacture a participation confirmation from an invitation list', async () => {
    const evidence = await repairEvidenceFor('review-recording')
    expect(evidence.confirmedSpeakerCount).toBeNull()
    expect(evidence.remoteReady).toBe(false)
    expect((await getRepairContext('review-recording')).actions).not.toContain('transcribe_recording')
  })
  it('persists an explicit fact anchored to the audio and preserves transcript content', async () => {
    const confirmation = await confirmRepairParticipation('review-recording', 2)
    expect(confirmation.provenance).toBe('user')
    expect(confirmation.sourceAudioHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await repairEvidenceFor('review-recording')).confirmedSpeakerCount).toBe(2)
    expect(queryOne<{ full_text: string }>('SELECT full_text FROM transcripts WHERE id = ?', ['review-transcript'])?.full_text)
      .toBe('Words must remain unchanged')
    await expect(confirmRepairParticipation('review-recording', 0)).rejects.toThrow('Speaker count')
  })
  it('does not attach a confirmation to a replaced audio file', async () => {
    writeFileSync(paths.audio, 'different audio fixture')
    expect((await repairEvidenceFor('review-recording')).confirmedSpeakerCount).toBeNull()
    await confirmRepairParticipation('review-recording', 2)
  })
  it('reuses a completed intent but refuses stale advice after a transcript edit', async () => {
    decide.mockResolvedValueOnce({ action: 'review_samples', automaticPromotionAllowed: false })
    const id = 'completed-advice-0001'
    const first = await getRepairAdvice('review-recording', id)
    expect(await getRepairAdvice('review-recording', id)).toEqual(first)
    expect(decide).toHaveBeenCalledTimes(1)
    run('UPDATE transcripts SET speakers = ? WHERE id = ?',
      [JSON.stringify([{ speaker: 'Corrected', start: 1, end: 8, text: 'A question' }]), 'review-transcript'])
    await expect(getRepairAdvice('review-recording', id)).rejects.toThrow('older source')
    expect(decide).toHaveBeenCalledTimes(1)
  })
  it('retains unknown outcome after failure and never retries the same intent automatically', async () => {
    decide.mockRejectedValueOnce(new Error('response lost'))
    await expect(getRepairAdvice('review-recording', 'unknown-advice-0001')).rejects.toThrow('response lost')
    const calls = decide.mock.calls.length
    await expect(getRepairAdvice('review-recording', 'unknown-advice-0001')).rejects.toThrow('no automatic redispatch')
    expect(decide.mock.calls.length).toBe(calls)
  })
  it('deletes retained review facts and results when the recording is hard-purged', () => {
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM quality_repair_state')?.n).toBeGreaterThan(0)
    run("DELETE FROM transcripts WHERE recording_id = 'review-recording'")
    run("DELETE FROM recordings WHERE id = 'review-recording'")
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM quality_repair_state')?.n).toBe(0)
  })
})
