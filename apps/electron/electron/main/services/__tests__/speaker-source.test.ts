// @vitest-environment node

/**
 * Each speaker assignment remembers where it came from (spec 2026-10-03, "How decisions are
 * recorded"): transcript_speakers.source and .confidence, written by assignSpeaker and by the
 * two voice writers that insert rows directly.
 *
 * REAL temp DB, real database.ts (better-sqlite3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-speaker-source-${process.pid}.sqlite`)

vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../config', () => ({
  getConfig: () => ({
    transcription: {
      speakerLinkingEnabled: true,
      speakerLinkingPythonPath: 'python',
      speakerLinkingWorkerPath: '',
      speakerLinkingModel: 'pyannote/speaker-diarization-community-1',
      speakerLinkingMatchThreshold: 0.72,
      speakerLinkingMatchMargin: 0.08,
      speakerLinkingMinSpeechSeconds: 4,
      speakerLinkingTimeoutSeconds: 600,
      localAsrHfToken: ''
    }
  })
}))

import { applyKnownVoiceBindings } from '../speaker-linking'
import { consolidateVoiceIdentityForSpeaker } from '../voice-identity-consolidation'
import { assignSpeaker, assignSpeakerFromHere, closeDatabase, initializeDatabase, queryAll, queryOne, run } from '../database'
import { listDecisions } from '../identity-decisions'

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
}

const provenance = (recordingId: string, label: string) =>
  queryOne<{ contact_id: string; source: string | null; confidence: number | null }>(
    'SELECT contact_id, source, confidence FROM transcript_speakers WHERE recording_id = ? AND speaker_label = ?',
    [recordingId, label]
  )

beforeEach(async () => {
  cleanup()
  await initializeDatabase()
  for (const id of ['rec', 'rec-2', 'rec-3']) {
    run('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)', [id, `${id}.wav`, '2026-10-01T10:00:00Z'])
  }
  run(`INSERT INTO contacts (id, name, type, first_seen_at, last_seen_at, source)
       VALUES ('person', 'Ana Ruiz', 'unknown', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 'user')`)
})

afterEach(() => {
  closeDatabase()
  cleanup()
})

describe('assignSpeaker', () => {
  it('writes the source and confidence it is given', () => {
    assignSpeaker('rec', 'Speaker 1', { contactId: 'person', source: 'self-identification', confidence: 0.97 })
    expect(provenance('rec', 'Speaker 1')).toEqual({ contact_id: 'person', source: 'self-identification', confidence: 0.97 })
  })

  it('replaces the source when the label is assigned again', () => {
    assignSpeaker('rec', 'Speaker 1', { contactId: 'person', source: 'speaker-inference', confidence: 0.7 })
    assignSpeaker('rec', 'Speaker 1', { contactId: 'person', source: 'manual', confidence: 1 })
    expect(provenance('rec', 'Speaker 1')).toEqual({ contact_id: 'person', source: 'manual', confidence: 1 })
  })

  it('leaves both empty when the caller says nothing', () => {
    assignSpeaker('rec', 'Speaker 1', { contactId: 'person' })
    expect(provenance('rec', 'Speaker 1')).toEqual({ contact_id: 'person', source: null, confidence: null })
  })

  it('"from here on" is the owner choosing, so it is manual', () => {
    run(`INSERT INTO transcripts (id, recording_id, full_text, speakers) VALUES ('t', 'rec', 'x', ?)`, [
      JSON.stringify([
        { start: 0, end: 1, speaker: 'Speaker 1', text: 'a' },
        { start: 1, end: 2, speaker: 'Speaker 1', text: 'b' }
      ])
    ])
    const { derivedLabel } = assignSpeakerFromHere('rec', 'Speaker 1', 1, { contactId: 'person' })
    expect(provenance('rec', derivedLabel)).toEqual({ contact_id: 'person', source: 'manual', confidence: 1 })
  })
})

describe('voice writers', () => {
  it('applyKnownVoiceBindings writes voice with the match similarity', () => {
    run(`INSERT INTO voice_clusters
      (id, model, model_version, embedding_dimension, centroid_json, observation_count, total_speech_seconds, contact_id)
      VALUES ('voice', 'community-1', '4.0.0', 3, '[1,0,0]', 2, 20, 'person')`)
    run(`INSERT INTO recording_voice_clusters
      (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id, match_status, similarity)
      VALUES ('rec-2', 'SPEAKER_00', 'Voice AAAAAA', 'voice', 'matched', 0.91)`)

    expect(applyKnownVoiceBindings('rec-2')).toBe(1)

    expect(provenance('rec-2', 'Voice AAAAAA')).toEqual({ contact_id: 'person', source: 'voice', confidence: 0.91 })
  })

  describe('when the speaker is already named after someone else (spec 2026-10-03, 2d)', () => {
    beforeEach(() => {
      run(`INSERT INTO contacts (id, name, type, first_seen_at, last_seen_at, source)
           VALUES ('other', 'Bea Paz', 'unknown', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 'user')`)
      run(`INSERT INTO voice_clusters
        (id, model, model_version, embedding_dimension, centroid_json, observation_count, total_speech_seconds, contact_id)
        VALUES ('voice', 'community-1', '4.0.0', 3, '[1,0,0]', 2, 20, 'person')`)
    })

    const tie = (similarity: number | null) =>
      run(`INSERT INTO recording_voice_clusters
        (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id, match_status, similarity)
        VALUES ('rec-2', 'SPEAKER_00', 'Speaker 1', 'voice', 'matched', ?)`, [similarity])
    const bound = (source: string | null) =>
      run(`INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence)
           VALUES ('ts', 'rec-2', 'Speaker 1', 'other', ?, 0.7)`, [source])
    const conflicts = () =>
      queryAll<{ target_id: string; evidence: string; status: string; source_recording_ids: string | null }>(
        "SELECT target_id, evidence, status, source_recording_ids FROM identity_suggestions WHERE json_extract(evidence, '$.type') = 'voice-conflict'"
      )

    it('replaces a lower-ranked source and journals the decision with the state before', () => {
      tie(0.93)
      bound('speaker-inference')

      expect(applyKnownVoiceBindings('rec-2')).toBe(1)

      expect(provenance('rec-2', 'Speaker 1')).toEqual({ contact_id: 'person', source: 'voice', confidence: 0.93 })
      const decisions = listDecisions()
      expect(decisions).toHaveLength(1)
      expect(decisions[0]).toMatchObject({ kind: 'speaker', method: 'voice', contactId: 'person', subjectKey: 'recording:rec-2:speaker:Speaker 1' })
      expect((decisions[0].before as { row: { contact_id: string } }).row.contact_id).toBe('other')
      expect(conflicts()).toEqual([])
    })

    it('never replaces a manual speaker: one voice-conflict suggestion, not two', () => {
      tie(0.93)
      bound('manual')

      expect(applyKnownVoiceBindings('rec-2')).toBe(0)
      expect(applyKnownVoiceBindings('rec-2')).toBe(0)

      expect(provenance('rec-2', 'Speaker 1')).toEqual({ contact_id: 'other', source: 'manual', confidence: 0.7 })
      const rows = conflicts()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ target_id: 'person', status: 'pending', source_recording_ids: '["rec-2"]' })
      expect(JSON.parse(rows[0].evidence)).toEqual({
        type: 'voice-conflict',
        recordingId: 'rec-2',
        speakerLabel: 'Speaker 1',
        voiceClusterId: 'voice',
        similarity: 0.93,
        voiceContactId: 'person',
        voiceContactName: 'Ana Ruiz',
        boundContactId: 'other',
        boundContactName: 'Bea Paz',
        boundSource: 'manual'
      })
    })

    it('treats a binding with no source as possibly manual: a suggestion, never a replacement', () => {
      tie(0.93)
      bound(null)
      applyKnownVoiceBindings('rec-2')
      expect(provenance('rec-2', 'Speaker 1')!.contact_id).toBe('other')
      expect(conflicts()).toHaveLength(1)
    })

    it('a higher-ranked source (self-identification) is kept and the conflict shown', () => {
      tie(0.93)
      bound('self-identification')
      applyKnownVoiceBindings('rec-2')
      expect(provenance('rec-2', 'Speaker 1')!.contact_id).toBe('other')
      expect(conflicts()).toHaveLength(1)
    })

    it('a voice under 0.9 changes nothing and raises nothing', () => {
      tie(0.8)
      bound('speaker-inference')
      expect(applyKnownVoiceBindings('rec-2')).toBe(0)
      expect(provenance('rec-2', 'Speaker 1')!.contact_id).toBe('other')
      expect(conflicts()).toEqual([])
    })

    it('the same person already named is left as it is', () => {
      tie(0.93)
      run(`INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence)
           VALUES ('ts', 'rec-2', 'Speaker 1', 'person', 'jev', 0.7)`)
      expect(applyKnownVoiceBindings('rec-2')).toBe(0)
      expect(provenance('rec-2', 'Speaker 1')).toEqual({ contact_id: 'person', source: 'jev', confidence: 0.7 })
      expect(listDecisions()).toEqual([])
    })
  })

  it('voice consolidation writes voice with the similarity that merged the cluster', () => {
    const clusters = [
      ['aaaaaaaa-0000-0000-0000-000000000000', '[1,0,0]', 'rec', 'Voice AAAAAA'],
      ['bbbbbbbb-0000-0000-0000-000000000000', '[0.99,0.05,0]', 'rec-3', 'Voice BBBBBB']
    ]
    for (const [clusterId, embedding, recordingId, stableLabel] of clusters) {
      run(`INSERT INTO voice_clusters
        (id, model, model_version, embedding_dimension, centroid_json, observation_count, total_speech_seconds)
        VALUES (?, 'community-1', '4.0.0', 3, ?, 1, 20)`, [clusterId, embedding])
      run(`INSERT INTO voice_cluster_observations
        (id, voice_cluster_id, recording_id, local_speaker_label, embedding_json, speech_seconds)
        VALUES (?, ?, ?, 'SPEAKER_00', ?, 20)`, [`obs-${recordingId}`, clusterId, recordingId, embedding])
      run(`INSERT INTO recording_voice_clusters
        (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id, match_status)
        VALUES (?, 'SPEAKER_00', ?, ?, 'new')`, [recordingId, stableLabel, clusterId])
    }
    assignSpeaker('rec', 'Voice AAAAAA', {
      contactId: 'person',
      voiceAnchor: { method: 'manual', confidence: 1 },
      source: 'manual',
      confidence: 1
    })

    const result = consolidateVoiceIdentityForSpeaker('rec', 'Voice AAAAAA', 'person')

    expect(result.mergedClusterIds).toEqual(['bbbbbbbb-0000-0000-0000-000000000000'])
    const row = provenance('rec-3', 'Voice AAAAAA')
    expect(row).toMatchObject({ contact_id: 'person', source: 'voice' })
    // cosine of [1,0,0] and [0.99,0.05,0]
    expect(row!.confidence).toBeCloseTo(0.99 / Math.hypot(0.99, 0.05), 3)
  })
})
