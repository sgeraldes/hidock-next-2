import { randomUUID } from 'crypto'
import { z } from 'zod'
import { queryAll, queryOne, run, runInTransaction, hasDecisionLabelRecoveryFailed } from '../database'
import { filterEligibleRecordingIds } from '../recording-eligibility'
import { buildKindExcerpt } from '../kind-fallback'
import { RECORDING_KINDS, type RecordingKind, type ReferenceLabelSet, type ReferenceLabelItem } from '../../../../src/shared/decision-labels'

const SAMPLING_RULE = 'lowest20-random20-v1'

const itemSchema = z.object({ setId: z.string().min(1).max(100), recordingId: z.string().min(1).max(200) }).strict()
const saveSchema = itemSchema.extend({ answer: z.enum(Object.keys(RECORDING_KINDS) as [RecordingKind, ...RecordingKind[]]) })
interface StoredSet { sampling_rule: string | null; id: string; created_at: string; sample_size: number; doubtful_count: number; random_count: number }

/** Shared sampling/read/write rule: fail-closed eligibility and a usable valid transcript. */
function availableRecordingIds(recordingIds: string[], sampling = false): Set<string> {
  const { eligible, failClosed } = filterEligibleRecordingIds(recordingIds)
  if (failClosed) {
    if (sampling) throw new Error('Recording eligibility could not be checked. Try again.')
    return new Set()
  }
  return new Set([...eligible].filter(id => {
    const transcript = queryOne<{ full_text: string | null }>(
      "SELECT full_text FROM transcripts WHERE recording_id = ? AND validity_status = 'valid'", [id])
    return !!transcript?.full_text?.trim()
  }))
}

/** Synchronous transaction: two first-use requests cannot create different samples. */
export function getLabelSet(): ReferenceLabelSet {
  return runInTransaction(() => {
    let set = queryOne<StoredSet>("SELECT id, created_at, sample_size, doubtful_count, random_count, sampling_rule FROM decision_label_sets WHERE question = 'kind'")
    if (set && !hasDecisionLabelRecoveryFailed() && set.sampling_rule !== SAMPLING_RULE && !queryOne(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND (name = 'decision_label_items_legacy' OR name GLOB 'decision_label_items_legacy_unrecovered_*') LIMIT 1"
    ) && !queryOne(`
      SELECT 1 FROM decision_label_items i JOIN decision_labels l
        ON l.recording_id = i.recording_id AND l.question = 'kind'
      WHERE i.set_id = ? LIMIT 1`, [set.id])) {
      run('DELETE FROM decision_label_sets WHERE id = ?', [set.id])
      set = undefined
    }
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
      const eligible = availableRecordingIds(candidates.map(row => row.recording_id), true)
      set = { sampling_rule: SAMPLING_RULE, id: randomUUID(), created_at: new Date().toISOString(), sample_size: 0, doubtful_count: 0, random_count: 0 }
      run("INSERT INTO decision_label_sets (id, question, created_at, sampling_rule) VALUES (?, 'kind', ?, ?)", [set.id, set.created_at, SAMPLING_RULE])
      const counts = { doubtful: 0, random: 0 }
      let position = 0
      const seen = new Set<string>()
      const usable = candidates.filter(row => {
        if (!eligible.has(row.recording_id) || seen.has(row.recording_id)) return false
        seen.add(row.recording_id)
        return true
      })
      const lowest = [...usable].sort((a, b) => a.kind_confidence - b.kind_confidence || a.recording_id.localeCompare(b.recording_id)).slice(0, 20)
      const doubtfulIds = new Set(lowest.map(row => row.recording_id))
      const sample = [...lowest, ...usable.filter(row => !doubtfulIds.has(row.recording_id)).slice(0, 20)]
      for (const row of sample) {
        const stratum = doubtfulIds.has(row.recording_id) ? 'doubtful' : 'random'
        run('INSERT INTO decision_label_items (set_id, recording_id, stratum, position) VALUES (?, ?, ?, ?)',
          [set.id, row.recording_id, stratum, position++])
        counts[stratum]++
      }
      set.sample_size = position
      set.doubtful_count = counts.doubtful
      set.random_count = counts.random
      run('UPDATE decision_label_sets SET sample_size = ?, doubtful_count = ?, random_count = ? WHERE id = ?',
        [position, counts.doubtful, counts.random, set.id])
    }
    const rows = queryAll<{ recording_id: string; position: number; stratum: 'doubtful' | 'random'; answer: RecordingKind | null }>(`
      SELECT i.recording_id, i.position, i.stratum, l.answer FROM decision_label_items i
      LEFT JOIN decision_labels l ON l.recording_id = i.recording_id AND l.question = 'kind'
      WHERE i.set_id = ? ORDER BY i.position`, [set.id])
    const eligible = availableRecordingIds(rows.map(row => row.recording_id))
    const available = rows.filter(row => eligible.has(row.recording_id))
    return {
      id: set.id, question: 'kind', createdAt: set.created_at,
      size: set.sample_size, unavailable: Math.max(0, set.sample_size - available.length),
      items: available.map(row => ({ recordingId: row.recording_id, position: row.position, answer: row.answer })),
      counts: { doubtful: set.doubtful_count, random: set.random_count },
      labeled: available.filter(row => row.answer !== null).length
    }
  })
}

/** Part 3 bench input: only currently eligible, labeled members of this sample. */
export function getEligibleLabeledRecordings(setId: string): Array<{ recordingId: string; answer: RecordingKind }> {
  const rows = queryAll<{ recordingId: string; answer: RecordingKind }>(`
    SELECT i.recording_id AS recordingId, l.answer FROM decision_label_items i
    JOIN decision_label_sets s ON s.id = i.set_id AND s.question = 'kind'
    JOIN decision_labels l ON l.recording_id = i.recording_id AND l.question = s.question
    WHERE i.set_id = ? ORDER BY i.position`, [z.string().min(1).max(100).parse(setId)])
  const eligible = availableRecordingIds(rows.map(row => row.recordingId))
  return rows.filter(row => eligible.has(row.recordingId))
}

export function getLabelItem(raw: unknown): ReferenceLabelItem | null {
  const args = itemSchema.parse(raw)
  if (!availableRecordingIds([args.recordingId]).has(args.recordingId)) return null
  const row = queryOne<Omit<ReferenceLabelItem, 'excerpt' | 'minutes' | 'meetingSubject'> & { full_text: string; subject: string | null }>(`
    SELECT r.id AS recordingId, r.date_recorded AS date, r.duration_seconds AS durationSeconds,
      m.subject, t.full_text, l.answer
    FROM decision_label_items i JOIN decision_label_sets s ON s.id = i.set_id AND s.question = 'kind'
    JOIN recordings r ON r.id = i.recording_id
    JOIN transcripts t ON t.recording_id = r.id AND t.validity_status = 'valid'
    LEFT JOIN meetings m ON m.id = r.meeting_id
    LEFT JOIN decision_labels l ON l.recording_id = r.id AND l.question = s.question
    WHERE i.set_id = ? AND i.recording_id = ?`, [args.setId, args.recordingId])
  if (!row) return null
  const { full_text, subject, ...item } = row
  return { ...item, ...buildKindExcerpt({ full_text, subject, duration_seconds: item.durationSeconds }) }
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
  // Membership-only: removing the owner's own label exposes no recording content.
  const args = itemSchema.parse(raw)
  if (!queryOne(`SELECT 1 FROM decision_label_items i JOIN decision_label_sets s ON s.id = i.set_id
    WHERE i.set_id = ? AND i.recording_id = ? AND s.question = 'kind'`, [args.setId, args.recordingId])) {
    throw new Error('Recording is not in this label set.')
  }
  run("DELETE FROM decision_labels WHERE recording_id = ? AND question = 'kind'", [args.recordingId])
}
