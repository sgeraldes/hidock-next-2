import { randomUUID } from 'crypto'
import { z } from 'zod'
import { queryAll, queryOne, run, runInTransaction } from '../database'
import { filterEligibleRecordingIds, isRecordingEligible } from '../recording-eligibility'
import { KIND_FALLBACK_MAX_JEV_CONFIDENCE } from '../jev-evaluation'
import { KIND_EXCERPT_CHARS } from '../kind-fallback'
import { RECORDING_KINDS, type RecordingKind, type ReferenceLabelSet, type ReferenceLabelItem } from '../../../../src/shared/decision-labels'

const itemSchema = z.object({ setId: z.string().min(1).max(100), recordingId: z.string().min(1).max(200) }).strict()
const saveSchema = itemSchema.extend({ answer: z.enum(Object.keys(RECORDING_KINDS) as [RecordingKind, ...RecordingKind[]]) })
const SCREEN_EXCERPT_CHARS = Math.min(3000, KIND_EXCERPT_CHARS)

/** Synchronous transaction: two first-use requests cannot create different samples. */
export function getLabelSet(): ReferenceLabelSet {
  return runInTransaction(() => {
    let set = queryOne<{ id: string; created_at: string }>("SELECT id, created_at FROM decision_label_sets WHERE question = 'kind'")
    if (!set) {
      const candidates = queryAll<{ recording_id: string; kind_confidence: number }>(`
        SELECT re.recording_id, re.kind_confidence FROM recording_evaluations re
        JOIN recordings r ON r.id = re.recording_id
        JOIN transcripts t ON t.recording_id = r.id
        WHERE re.version > 0 AND COALESCE(re.model, '') != 'rules-v1'
          AND re.kind_confidence IS NOT NULL
          AND re.capture_id = (SELECT latest.capture_id FROM recording_evaluations latest
            WHERE latest.recording_id = re.recording_id AND latest.version > 0
              AND COALESCE(latest.model, '') != 'rules-v1'
            ORDER BY latest.evaluated_at DESC, latest.capture_id DESC LIMIT 1)
          AND r.deleted_at IS NULL AND COALESCE(r.personal, 0) = 0
          AND t.validity_status = 'valid' AND LENGTH(TRIM(t.full_text)) > 0
        ORDER BY RANDOM()`)
      const { eligible, failClosed } = filterEligibleRecordingIds(candidates.map(row => row.recording_id))
      if (failClosed) throw new Error('Recording eligibility could not be checked. Try again.')
      set = { id: randomUUID(), created_at: new Date().toISOString() }
      run("INSERT INTO decision_label_sets (id, question, created_at) VALUES (?, 'kind', ?)", [set.id, set.created_at])
      const counts = { doubtful: 0, confident: 0 }
      let position = 0
      const seen = new Set<string>()
      for (const row of candidates) {
        const stratum = row.kind_confidence < KIND_FALLBACK_MAX_JEV_CONFIDENCE ? 'doubtful' : 'confident'
        if (!eligible.has(row.recording_id) || seen.has(row.recording_id) || counts[stratum] >= 20) continue
        run('INSERT INTO decision_label_items (set_id, recording_id, stratum, position) VALUES (?, ?, ?, ?)',
          [set.id, row.recording_id, stratum, position++])
        counts[stratum]++
        seen.add(row.recording_id)
      }
    }
    const rows = queryAll<{ recording_id: string; position: number; stratum: 'doubtful' | 'confident'; answer: RecordingKind | null }>(`
      SELECT i.recording_id, i.position, i.stratum, l.answer FROM decision_label_items i
      LEFT JOIN decision_labels l ON l.recording_id = i.recording_id AND l.question = 'kind'
      WHERE i.set_id = ? ORDER BY i.position`, [set.id])
    return {
      id: set.id, question: 'kind', createdAt: set.created_at,
      items: rows.map(row => ({ recordingId: row.recording_id, position: row.position, answer: row.answer })),
      counts: { doubtful: rows.filter(row => row.stratum === 'doubtful').length, confident: rows.filter(row => row.stratum === 'confident').length },
      labeled: rows.filter(row => row.answer !== null).length
    }
  })
}

export function getLabelItem(raw: unknown): ReferenceLabelItem | null {
  const args = itemSchema.parse(raw)
  if (!isRecordingEligible(args.recordingId)) return null
  return queryOne<ReferenceLabelItem>(`
    SELECT r.id AS recordingId, r.date_recorded AS date, r.duration_seconds AS durationSeconds,
      m.subject AS meetingSubject, SUBSTR(t.full_text, 1, ?) AS excerpt, l.answer
    FROM decision_label_items i JOIN decision_label_sets s ON s.id = i.set_id AND s.question = 'kind'
    JOIN recordings r ON r.id = i.recording_id
    JOIN transcripts t ON t.recording_id = r.id AND t.validity_status = 'valid'
    LEFT JOIN meetings m ON m.id = r.meeting_id
    LEFT JOIN decision_labels l ON l.recording_id = r.id AND l.question = s.question
    WHERE i.set_id = ? AND i.recording_id = ?`, [SCREEN_EXCERPT_CHARS, args.setId, args.recordingId]) ?? null
}

export function saveLabel(raw: unknown): void {
  const args = saveSchema.parse(raw)
  if (!getLabelItem(argsWithoutAnswer(args))) throw new Error('This recording is no longer available for labeling.')
  run(`INSERT INTO decision_labels (recording_id, question, answer, labeled_at) VALUES (?, 'kind', ?, ?)
    ON CONFLICT(recording_id, question) DO UPDATE SET answer = excluded.answer, labeled_at = excluded.labeled_at`,
  [args.recordingId, args.answer, new Date().toISOString()])
}

function argsWithoutAnswer(args: { setId: string; recordingId: string }) {
  return { setId: args.setId, recordingId: args.recordingId }
}

export function clearLabel(raw: unknown): void {
  const args = itemSchema.parse(raw)
  if (!queryOne(`SELECT 1 FROM decision_label_items i JOIN decision_label_sets s ON s.id = i.set_id
    WHERE i.set_id = ? AND i.recording_id = ? AND s.question = 'kind'`, [args.setId, args.recordingId])) {
    throw new Error('Recording is not in this label set.')
  }
  run("DELETE FROM decision_labels WHERE recording_id = ? AND question = 'kind'", [args.recordingId])
}
