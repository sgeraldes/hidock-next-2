/**
 * The questions agents may ask the second brain, and the answers they get.
 *
 * Every function here returns what the matching `window.electronAPI` call
 * returned to the old CDP bridge, so the scripts that read those answers keep
 * working field for field: `hidock_bridge.mjs`, `coverage/ingest.py` (which
 * feeds the board) and the dfx5-interviews skill.
 *
 * And every one of them goes through the app's own eligibility gate, not a copy
 * of it (see capture-read-model.ts and actionable-read-model.ts). That gate is
 * what keeps a recording the owner marked personal, deleted or value-excluded —
 * and everything derived from it — away from assistants. One deliberate
 * difference from the app: `recordings:getForMeeting` does NOT gate, because it
 * serves the owner's own meeting page. Its brain counterpart below does,
 * because an agent is not the owner's management UI.
 *
 * Spec: docs/superpowers/specs/2026-09-22-brain-service-design.md
 */

import {
  getMeetingById,
  getMeetings,
  getRecordingsForMeeting,
  getTranscriptByRecordingId,
  queryAll,
  queryOne,
  type Meeting,
} from './database'
import { filterEligibleRecordingIds } from './recording-eligibility'
import { rankRecordingsByMeetingCoverage } from './recording-match-scoring'
import { gateActionables, mapToActionable } from './actionable-read-model'
import {
  KNOWLEDGE_CAPTURE_COLUMNS,
  applyCaptureEligibility,
  mapToKnowledgeCapture,
  type CaptureRow,
} from './capture-read-model'
import type { Actionable, KnowledgeCapture } from '@/types/knowledge'

/** Longest id the brain will look up. Anything longer is not an id. */
const MAX_ID_LENGTH = 200

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

/**
 * Meetings that started on or after `since` and have already started, oldest
 * first, all-day events left out. The same filter the bridge applied to
 * `meetings.getAll()` on its side.
 */
export function meetingsSince(since: string, now: Date = new Date()): Meeting[] {
  const nowIso = now.toISOString()
  return getMeetings()
    .filter((m) => (m.start_time ?? '') >= since && !m.is_all_day && (m.start_time ?? '') <= nowIso)
    .sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? ''))
}

/** Pending actionables created on or after `since`, newest first. */
export function pendingActionablesSince(since: string): Actionable[] {
  const rows = queryAll<{ source_knowledge_id?: string | null; created_at?: string | null }>(
    "SELECT * FROM actionables WHERE status = 'pending' ORDER BY created_at DESC"
  )
  return gateActionables(rows)
    .map(mapToActionable)
    .filter((a) => (a.createdAt ?? '') >= since)
}

/** One actionable, or null when it does not exist or its source is excluded. */
export function actionableById(id: unknown): Actionable | null {
  if (!isId(id)) return null
  const row = queryOne<{ source_knowledge_id?: string | null }>('SELECT * FROM actionables WHERE id = ?', [id])
  if (!row) return null
  const [kept] = gateActionables([row])
  return kept ? mapToActionable(kept) : null
}

/** Knowledge captures by id; excluded ones are simply absent. */
export function knowledgeByIds(ids: unknown[]): KnowledgeCapture[] {
  const clean = ids.filter(isId)
  if (clean.length === 0) return []
  const placeholders = clean.map(() => '?').join(',')
  const rows = queryAll<CaptureRow>(
    `SELECT ${KNOWLEDGE_CAPTURE_COLUMNS} FROM knowledge_captures WHERE id IN (${placeholders})`,
    clean
  )
  const { kept, failClosed } = applyCaptureEligibility(rows, 'gated')
  return failClosed ? [] : kept.map(mapToKnowledgeCapture)
}

/** One knowledge capture, or null when absent or excluded. */
export function knowledgeById(id: unknown): KnowledgeCapture | null {
  if (!isId(id)) return null
  const row = queryOne<CaptureRow>(`SELECT ${KNOWLEDGE_CAPTURE_COLUMNS} FROM knowledge_captures WHERE id = ?`, [id])
  if (!row) return null
  const { kept, failClosed } = applyCaptureEligibility([row], 'gated')
  return failClosed || kept.length === 0 ? null : mapToKnowledgeCapture(kept[0])
}

/**
 * The recordings of a meeting with their transcripts, the one holding most of
 * the meeting first. Excluded recordings are left out entirely, transcript and
 * all, and any failure to check eligibility returns nothing rather than
 * everything.
 */
export function meetingRecordings(meetingId: unknown): unknown[] {
  if (!isId(meetingId)) return []
  const recordings = getRecordingsForMeeting(meetingId)
  if (recordings.length === 0) return []
  const { eligible, failClosed } = filterEligibleRecordingIds(recordings.map((r) => r.id))
  if (failClosed) return []
  const withTranscripts = recordings
    .filter((r) => eligible.has(r.id))
    .map((recording) => ({ ...recording, transcript: getTranscriptByRecordingId(recording.id) }))

  const meeting = getMeetingById(meetingId)
  if (!meeting?.start_time || !meeting?.end_time) return withTranscripts
  return rankRecordingsByMeetingCoverage(
    withTranscripts.map((recording) => ({
      ...recording,
      dateRecorded: recording.date_recorded,
      durationSeconds: recording.duration_seconds,
    })),
    { startTime: meeting.start_time, endTime: meeting.end_time }
  )
}

/** A recording's transcript, or null when absent or the recording is excluded. */
export function transcriptForRecording(recordingId: unknown): unknown {
  if (!isId(recordingId)) return null
  const { eligible, failClosed } = filterEligibleRecordingIds([recordingId])
  if (failClosed || !eligible.has(recordingId)) return null
  return getTranscriptByRecordingId(recordingId) ?? null
}
