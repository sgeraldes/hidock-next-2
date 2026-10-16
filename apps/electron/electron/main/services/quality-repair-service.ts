import { createHash } from 'crypto'
import { createReadStream, statSync } from 'fs'
import { queryAll, queryOne, run, runNoSave, getTurnOverrides, getSpeakerSplits, getSpeakerMap } from './database'
import { isRecordingTranscribable } from './recording-eligibility'
import { getConfig } from './config'
import { checkModelHost } from './model-host-client'
import { buildRepairAdvice, requestRepairAdvice, type RepairEvidence, type RepairTurn } from './quality-repair-advice'
import { readReviewAudio } from './quality-review-audio'
import { compareRepairVoices } from './repair-voice-evidence'

const factsKey = (id: string) => JSON.stringify([id, 'participation'])
const intentKey = (id: string, requestId: string) => JSON.stringify([id, `advice:${requestId}`])
const STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS quality_repair_state (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  state_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(recording_id, state_key)
)`
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function parsed<T>(text: string | null, fallback: T): T {
  try { return text ? JSON.parse(text) as T : fallback } catch { return fallback }
}
function stored<T>(key: string): T | null {
  runNoSave(STATE_SCHEMA)
  const [id, stateKey] = JSON.parse(key) as [string, string]
  return parsed(queryOne<{ value: string }>(
    'SELECT value FROM quality_repair_state WHERE recording_id = ? AND state_key = ?', [id, stateKey])?.value || null, null)
}
function save(key: string, value: unknown): void {
  runNoSave(STATE_SCHEMA)
  const [id, stateKey] = JSON.parse(key) as [string, string]
  run('INSERT OR REPLACE INTO quality_repair_state (recording_id, state_key, value) VALUES (?, ?, ?)',
    [id, stateKey, JSON.stringify(value)])
}
interface Source {
  speakers: string | null; validity_json: string | null; file_path: string | null;
  duration_seconds: number | null; subject: string | null; attendees: string | null
}
interface Participation { sourceAudioHash: string; count: number; confirmedAt: string; provenance: 'user' }
interface SampleConfirmation {
  sourceAudioHash: string; start: number; end: number; role: 'owner' | 'other' | 'overlap' | 'unsure'; confirmedAt: string
}

function source(id: string): Source {
  if (!isRecordingTranscribable(id)) throw new Error('Recording is not eligible for quality review')
  const row = queryOne<Source>(`SELECT t.speakers, t.validity_json, r.file_path, r.duration_seconds,
    m.subject, m.attendees FROM transcripts t JOIN recordings r ON r.id = t.recording_id
    LEFT JOIN meetings m ON m.id = r.meeting_id WHERE r.id = ?`, [id])
  if (!row?.file_path) throw new Error('A local audio source and existing transcript are required')
  return row
}
function revision(id: string, row: Source): string {
  runNoSave(STATE_SCHEMA)
  const file = statSync(row.file_path!)
  return hash(JSON.stringify([row.speakers, row.validity_json, row.file_path, row.duration_seconds,
    file.size, file.mtimeMs, row.subject, row.attendees,
    getTurnOverrides(id), getSpeakerSplits(id), getSpeakerMap(id),
    queryAll('SELECT state_key, value FROM quality_repair_state WHERE recording_id = ? AND state_key LIKE ? ORDER BY state_key',
      [id, 'sample:%']),
    queryAll('SELECT local_speaker_label, match_status, similarity, runner_up_margin FROM recording_voice_clusters WHERE recording_id = ? ORDER BY local_speaker_label LIMIT 32',
      [id])]))
}
async function audioHash(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

/** Explicit participation confirmation is anchored to audio, not to mutable turn indices. */
export async function confirmRepairParticipation(recordingId: string, count: number): Promise<Participation> {
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Speaker count must be between 1 and 32')
  const row = source(recordingId)
  const originalRevision = revision(recordingId, row)
  const fingerprint = await audioHash(row.file_path!)
  if (revision(recordingId, source(recordingId)) !== originalRevision) throw new Error('Source changed during confirmation')
  const value: Participation = { sourceAudioHash: fingerprint, count, provenance: 'user', confirmedAt: new Date().toISOString() }
  save(factsKey(recordingId), value)
  return value
}

export async function repairEvidenceFor(recordingId: string): Promise<RepairEvidence> {
  const row = source(recordingId)
  const expectedRevision = revision(recordingId, row)
  const sourceAudioHash = await audioHash(row.file_path!)
  const confirmation = stored<Participation>(factsKey(recordingId))
  const sampleConfirmations = queryAll<{ value: string }>(
    "SELECT value FROM quality_repair_state WHERE recording_id = ? AND state_key LIKE 'sample:%' LIMIT 128", [recordingId])
    .map(row => parsed<SampleConfirmation | null>(row.value, null))
    .filter((row): row is SampleConfirmation => !!row && row.sourceAudioHash === sourceAudioHash)
    .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)).slice(0, 24)
  const turns = parsed<RepairTurn[]>(row.speakers, [])
  if (!Array.isArray(turns)) throw new Error('Transcript turns are malformed')
  const validity = parsed<{ reasons?: Array<{ code: string; detail: string }> }>(row.validity_json, {})
  const attendees = parsed<unknown[]>(row.attendees, [])
  // These are observations, never probabilities invented from transcript wording.
  const acousticRows = queryAll(`SELECT local_speaker_label, match_status, similarity, runner_up_margin
    FROM recording_voice_clusters WHERE recording_id = ? ORDER BY local_speaker_label LIMIT 32`, [recordingId])
  const observations = queryAll<{ label: string; model: string; version: string; dimension: number;
    embedding: string; speechSeconds: number | null }>(`SELECT r.transcript_speaker_label AS label,
    v.model, v.model_version AS version, v.embedding_dimension AS dimension,
    o.embedding_json AS embedding, o.speech_seconds AS speechSeconds
    FROM recording_voice_clusters r JOIN voice_clusters v ON v.id = r.voice_cluster_id
    JOIN voice_cluster_observations o ON o.recording_id = r.recording_id
      AND o.local_speaker_label = r.local_speaker_label AND o.voice_cluster_id = r.voice_cluster_id
    WHERE r.recording_id = ? ORDER BY r.local_speaker_label LIMIT 16`, [recordingId])
    .map(row => ({ ...row, embedding: parsed<unknown>(row.embedding, null) }))
  const config = getConfig().transcription
  const health = config.modelHostUrl && config.modelHostToken
    ? await checkModelHost({ url: config.modelHostUrl, token: config.modelHostToken }).catch(() => null) : null
  const evidence: RepairEvidence = {
    recordingId, sourceAudioHash, transcriptFingerprint: expectedRevision,
    durationSeconds: row.duration_seconds || 0, turns,
    reasons: Array.isArray(validity.reasons) ? validity.reasons : [],
    confirmedSpeakerCount: confirmation?.provenance === 'user' && confirmation.sourceAudioHash === sourceAudioHash
      ? confirmation.count : null,
    confirmedAudioSamples: sampleConfirmations.map(({ start, end, role }) => ({ start, end, role })),
    invitedCount: Array.isArray(attendees) ? attendees.length : null,
    meetingKind: null, meetingSubject: row.subject,
    acousticEvidence: acousticRows.length ? { recordingVoiceObservations: acousticRows,
      withinRecordingComparison: compareRepairVoices(observations),
      individualAudioSamplesHaveNotBeenCompared: true } : null,
    // Only actions with an implemented review behavior are offered here. New
    // stage executors must register explicitly rather than pretending readiness.
    availableActions: ['review_samples'], remoteReady: health?.state === 'ready',
    stillCurrent: () => {
      try { return isRecordingTranscribable(recordingId) && revision(recordingId, source(recordingId)) === expectedRevision
        && JSON.stringify(stored(factsKey(recordingId))) === JSON.stringify(confirmation) } catch { return false }
    }
  }
  if (!evidence.stillCurrent()) throw new Error('Recording changed while preparing repair context')
  return evidence
}

export async function getRepairContext(recordingId: string) {
  return buildRepairAdvice(await repairEvidenceFor(recordingId))
}

export async function getRepairSample(recordingId: string, sampleId: string, evidenceFingerprint: string) {
  const evidence = await repairEvidenceFor(recordingId)
  const plan = buildRepairAdvice(evidence)
  if (plan.evidenceFingerprint !== evidenceFingerprint) throw new Error('Review context changed; reload the samples')
  const sample = plan.samples.find(row => row.id === sampleId)
  if (!sample) throw new Error('Sample is not part of the current review plan')
  const audio = await readReviewAudio(source(recordingId).file_path!, sample.context.start,
    sample.context.end - sample.context.start)
  if (!evidence.stillCurrent()) throw new Error('Source changed while extracting sample; audio not returned')
  return { sample, mimeType: 'audio/mpeg', base64: audio.toString('base64'),
    targetOffsetSeconds: sample.target.start - sample.context.start }
}

export async function confirmRepairSample(recordingId: string, sampleId: string, fingerprint: string,
  role: SampleConfirmation['role']) {
  if (!['owner', 'other', 'overlap', 'unsure'].includes(role)) throw new Error('Unsupported sample confirmation')
  const evidence = await repairEvidenceFor(recordingId)
  const plan = buildRepairAdvice(evidence)
  if (plan.evidenceFingerprint !== fingerprint) throw new Error('Review context changed; reload before confirming')
  const sample = plan.samples.find(row => row.id === sampleId)
  if (!sample) throw new Error('Sample is not in the current plan')
  const confirmation: SampleConfirmation = { sourceAudioHash: evidence.sourceAudioHash,
    start: sample.target.start, end: sample.target.end, role, confirmedAt: new Date().toISOString() }
  if (!evidence.stillCurrent()) throw new Error('Source changed; confirmation was not saved')
  save(JSON.stringify([recordingId, `sample:${confirmation.start}:${confirmation.end}`]), confirmation)
  return confirmation
}

/** One explicit advice intent; a crash/network failure never silently redispatches it. */
export async function getRepairAdvice(recordingId: string, requestId: string) {
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) throw new Error('A stable advice request ID is required')
  const key = intentKey(recordingId, requestId)
  const existing = stored<{ status: string; revision?: string; participation?: unknown; result?: unknown }>(key)
  if (existing?.status === 'completed') {
    if (revision(recordingId, source(recordingId)) !== existing.revision
      || JSON.stringify(stored(factsKey(recordingId))) !== JSON.stringify(existing.participation)) {
      throw new Error('Stored advice belongs to an older source or confirmation; no changes applied')
    }
    return existing.result
  }
  if (existing) throw new Error('Advice outcome is unknown or already running; no automatic redispatch')
  const evidence = await repairEvidenceFor(recordingId)
  // Recheck after async preparation: two identical IPC requests can reach here.
  if (stored(key)) throw new Error('Advice is already running; no duplicate dispatch')
  save(key, { status: 'outcome-unknown', sourceAudioHash: evidence.sourceAudioHash,
    revision: evidence.transcriptFingerprint, startedAt: new Date().toISOString() })
  const result = await requestRepairAdvice(evidence)
  save(key, { status: 'completed', revision: evidence.transcriptFingerprint,
    participation: stored(factsKey(recordingId)), result })
  return result
}
