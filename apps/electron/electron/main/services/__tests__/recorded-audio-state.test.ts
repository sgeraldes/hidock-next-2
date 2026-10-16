/** @vitest-environment node */
import { it, expect, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { createHash } from 'crypto'
vi.mock('../database', () => ({
  getDatabase: () => {
    throw new Error('Production database forbidden')
  }
}))
import { RecordedAudioState } from '../recorded-audio-state'
const sha = 'a'.repeat(64),
  version = 'fixture-v1'
it('persists source-bound layout/tracks, reopens SQLite, preserves old rows and cascades recording deletion', async () => {
  const SQL = await initSqlJs()
  let db = new SQL.Database()
  db.run(
    "PRAGMA foreign_keys=ON;CREATE TABLE recordings(id TEXT PRIMARY KEY);INSERT INTO recordings VALUES('recording');CREATE TABLE old_data(value TEXT);INSERT INTO old_data VALUES('keep')"
  )
  let state = new RecordedAudioState(db)
  const layout = {
    container: 'wav' as const,
    codec: 'pcm_s16le',
    channels: 2,
    sampleRate: 16000,
    durationSeconds: 1,
    durationSource: 'decoded-frames' as const,
    originalSha256: sha
  }
  state.saveLayout('recording', layout)
  const mapping = {
    evidence: 'user-confirmed' as const,
    evidenceId: 'confirmation',
    roles: ['microphone', 'system'] as const
  }
  state.setMapping('recording', sha, { ...mapping, roles: [...mapping.roles] })
  const tracks = [0, 1].map((channelIndex) => ({
    id: createHash('sha256').update(`${sha}:${channelIndex}:${version}`).digest('hex'),
    channelIndex,
    path: 'private-temporary-path',
    sampleRate: 16000 as const,
    frames: 16000,
    durationSeconds: 1,
    sourceRole: 'unknown' as const,
    mappingEvidence: null,
    timelineOffsetSeconds: 0 as const
  }))
  state.saveTracks('recording', sha, version, tracks)
  const bytes = db.export()
  db.close()
  db = new SQL.Database(bytes)
  db.run('PRAGMA foreign_keys=ON')
  state = new RecordedAudioState(db)
  expect(state.getLayout('recording', sha)).toEqual(layout)
  expect(state.getMapping('recording', sha)).toEqual(mapping)
  expect(state.getTracks('recording', sha)).toHaveLength(2)
  expect(JSON.stringify(state.getTracks('recording', sha))).not.toContain('private-temporary-path')
  expect(state.getLayout('recording', 'b'.repeat(64))).toBeNull()
  expect(() => state.saveTracks('recording', sha, version, [{ ...tracks[0], id: 'b'.repeat(64) }, tracks[1]])).toThrow(
    /identity/
  )
  expect(() => state.setMapping('recording', sha, { ...mapping, roles: ['microphone'] })).toThrow(/mapping/)
  expect(db.exec('SELECT value FROM old_data')[0].values).toEqual([['keep']])
  db.run("DELETE FROM recordings WHERE id='recording'")
  expect(state.getLayout('recording', sha)).toBeNull()
  expect(state.getTracks('recording', sha)).toEqual([])
  db.close()
})
