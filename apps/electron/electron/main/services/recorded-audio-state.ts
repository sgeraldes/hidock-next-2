import { createHash } from 'crypto'
import { getDatabase } from './database'
import type {
  RecordedAudioLayout,
  RecordedAudioChannel,
  RecordedAudioRoleMapping
} from '../../../src/shared/recorded-audio-layout'
interface AudioStateDatabase {
  run(sql: string, params?: any[]): unknown
  exec(sql: string, params?: any[]): Array<{ columns: string[]; values: any[][] }>
}
export class RecordedAudioState {
  constructor(private readonly db: AudioStateDatabase = getDatabase()) {}
  private schema(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS recording_audio_layouts (
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, source_sha TEXT NOT NULL,
      layout_json TEXT NOT NULL, mapping_json TEXT, PRIMARY KEY(recording_id,source_sha))`)
    this.db.run(`CREATE TABLE IF NOT EXISTS recording_audio_tracks (
      recording_id TEXT NOT NULL,source_sha TEXT NOT NULL,track_id TEXT NOT NULL,channel_index INTEGER NOT NULL,
      transform_version TEXT NOT NULL,track_json TEXT NOT NULL,
      PRIMARY KEY(recording_id,source_sha,transform_version,channel_index),
      FOREIGN KEY(recording_id,source_sha) REFERENCES recording_audio_layouts(recording_id,source_sha) ON DELETE CASCADE)`)
  }
  private key(id: string, sha: string): void {
    if (!id?.trim() || !/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid recorded audio identity')
  }
  saveLayout(id: string, layout: RecordedAudioLayout): void {
    this.key(id, layout.originalSha256)
    this.schema()
    if (
      !Number.isInteger(layout.channels) ||
      layout.channels < 1 ||
      layout.channels > 32 ||
      !Number.isFinite(layout.sampleRate) ||
      layout.sampleRate <= 0 ||
      !Number.isFinite(layout.durationSeconds) ||
      layout.durationSeconds <= 0
    )
      throw new Error('Invalid recorded audio layout')
    this.db.run(
      `INSERT INTO recording_audio_layouts(recording_id,source_sha,layout_json) VALUES(?,?,?)
      ON CONFLICT(recording_id,source_sha) DO UPDATE SET layout_json=excluded.layout_json`,
      [id, layout.originalSha256, JSON.stringify(layout)]
    )
  }
  getLayout(id: string, sha: string): RecordedAudioLayout | null {
    this.key(id, sha)
    this.schema()
    const value = this.db.exec(
      'SELECT layout_json FROM recording_audio_layouts WHERE recording_id=? AND source_sha=?',
      [id, sha]
    )[0]?.values[0]?.[0]
    return value ? JSON.parse(String(value)) : null
  }
  getMapping(id: string, sha: string): RecordedAudioRoleMapping | null {
    this.key(id, sha)
    this.schema()
    const value = this.db.exec(
      'SELECT mapping_json FROM recording_audio_layouts WHERE recording_id=? AND source_sha=?',
      [id, sha]
    )[0]?.values[0]?.[0]
    return value ? JSON.parse(String(value)) : null
  }
  setMapping(id: string, sha: string, mapping: RecordedAudioRoleMapping | null): void {
    const layout = this.getLayout(id, sha)
    if (!layout) throw new Error('Recorded audio layout not found')
    if (
      mapping &&
      (!['user-confirmed', 'verified-recorded-metadata'].includes(mapping.evidence) ||
        !mapping.evidenceId?.trim() ||
        mapping.evidenceId.length > 512 ||
        mapping.roles.length !== layout.channels ||
        mapping.roles.some((r) => !['unknown', 'microphone', 'system'].includes(r)))
    )
      throw new Error('Invalid channel mapping evidence')
    this.db.run('UPDATE recording_audio_layouts SET mapping_json=? WHERE recording_id=? AND source_sha=?', [
      mapping ? JSON.stringify(mapping) : null,
      id,
      sha
    ])
  }
  saveTracks(id: string, sha: string, version: string, tracks: RecordedAudioChannel[]): void {
    const layout = this.getLayout(id, sha)
    if (!layout) throw new Error('Recorded audio layout not found')
    if (
      !version ||
      tracks.length !== layout.channels ||
      new Set(tracks.map((t) => t.channelIndex)).size !== tracks.length
    )
      throw new Error('Invalid channel track set')
    const rows = tracks.map((track) => {
      if (
        !Number.isInteger(track.channelIndex) ||
        track.channelIndex < 0 ||
        track.channelIndex >= layout.channels ||
        !/^[a-f0-9]{64}$/.test(track.id) ||
        track.sampleRate !== 16000 ||
        !Number.isInteger(track.frames) ||
        track.frames < 1 ||
        track.timelineOffsetSeconds !== 0
      )
        throw new Error('Invalid recorded audio track')
      if (
        track.id !== createHash('sha256').update(`${sha}:${track.channelIndex}:${version}`).digest('hex') ||
        track.durationSeconds !== track.frames / track.sampleRate ||
        !['unknown', 'microphone', 'system'].includes(track.sourceRole)
      )
        throw new Error('Track identity or sample clock mismatch')
      const { path: _path, ...metadata } = track
      return [id, sha, track.id, track.channelIndex, version, JSON.stringify(metadata)]
    })
    this.db.run('SAVEPOINT recorded_audio_tracks')
    try {
      for (const row of rows)
        this.db.run(
          `INSERT INTO recording_audio_tracks VALUES(?,?,?,?,?,?) ON CONFLICT(recording_id,source_sha,transform_version,channel_index) DO UPDATE SET track_id=excluded.track_id,track_json=excluded.track_json`,
          row
        )
      this.db.run('RELEASE recorded_audio_tracks')
    } catch (error) {
      this.db.run('ROLLBACK TO recorded_audio_tracks')
      this.db.run('RELEASE recorded_audio_tracks')
      throw error
    }
  }
  getTracks(id: string, sha: string): Array<Omit<RecordedAudioChannel, 'path'> & { transformVersion: string }> {
    this.key(id, sha)
    this.schema()
    return (
      this.db.exec(
        'SELECT track_json,transform_version FROM recording_audio_tracks WHERE recording_id=? AND source_sha=? ORDER BY transform_version,channel_index',
        [id, sha]
      )[0]?.values ?? []
    ).map((row) => ({ ...JSON.parse(String(row[0])), transformVersion: String(row[1]) }))
  }
}
