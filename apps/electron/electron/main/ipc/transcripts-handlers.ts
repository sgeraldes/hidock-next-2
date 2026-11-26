/**
 * Transcript Speaker IPC Handlers
 *
 * Binds transcript speaker labels (e.g. "Speaker 1") to canonical contacts,
 * so a transcript can render real identities. Uses the Result pattern.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  assignSpeaker,
  getSpeakerMap,
  unassignSpeaker,
  getRecordingById,
  resolveRecordingId,
  queryOne,
  run,
  runInTransaction,
  runNoSave,
  Contact,
  SpeakerMapEntry,
  getActiveProcessingRunsForRecording,
  refreshTranscriptIntegrity
} from '../services/database'
import { isRecordingEligible } from '../services/recording-eligibility'
import { consolidateVoiceIdentityForSpeaker } from '../services/voice-identity-consolidation'
import { getVectorStore } from '../services/vector-store'
import { exportMeetingWiki } from '../services/meeting-wiki'
import { syncTrustVerdicts } from '../services/transcript-trust'
import { getDiarizedSegments } from '../services/diarization-store'
import { retrySummary } from '../services/transcription'
import { success, error, Result } from '../types/api'
import { getTranscriptTiming, loadTimingState } from '../services/transcript-timing-store'
import { applyTimingReview, spliceSection, type TimingReviewRequest } from '../services/transcript-timing-evidence'
import { alignToSpeech } from '../services/transcript-time-aligner'
import { fixTimesOnModelHost } from '../services/transcript-host-alignment'
import { hasInlineTurns, renderedTurnCounts } from '../../../src/shared/inline-turns'
import { transcriptFingerprint } from '../services/transcript-validity-store'
import { OVERLAP_SECONDS, type TimingSegment } from '../../../src/shared/transcript-timing'
import { UUIDSchema } from '../validation/common'

// Recording ids are UUIDs post-migration, but keep this permissive so a legacy
// or externally-imported recording id is never rejected at the boundary.
const RecordingIdSchema = z.string().min(1).max(200)
const SpeakerLabelSchema = z.string().min(1).max(200)

const AssignSpeakerRequestSchema = z
  .object({
    recordingId: RecordingIdSchema,
    speakerLabel: SpeakerLabelSchema,
    contactId: UUIDSchema.optional(),
    newName: z.string().min(1).max(500).optional()
  })
  .refine((data) => data.contactId !== undefined || (data.newName !== undefined && data.newName.trim().length > 0), {
    message: 'Either contactId or newName is required'
  })

const GetSpeakerMapRequestSchema = z.object({
  recordingId: RecordingIdSchema
})

const UnassignSpeakerRequestSchema = z.object({
  recordingId: RecordingIdSchema,
  speakerLabel: SpeakerLabelSchema
})

const UpdateExtractedItemRequestSchema = z.object({
  recordingId: RecordingIdSchema,
  kind: z.enum(['action', 'decision']),
  index: z.number().int().min(0).max(10000),
  content: z.string().trim().min(1).max(4000)
})

const EditableTranscriptSegmentSchema = z
  .object({
    speaker: z.string().trim().min(1).max(200).optional(),
    start: z.number().finite().min(0).max(7 * 24 * 60 * 60),
    end: z.number().finite().min(0).max(7 * 24 * 60 * 60).optional(),
    text: z.string().trim().min(1).max(50_000),
    // How the speaker was attributed (speaker-linking.ts). Kept through an edit so
    // correcting a word does not erase the diarization quality marks.
    speakerAttribution: z.string().trim().min(1).max(40).optional(),
    speakerConfidence: z.number().finite().min(0).max(1).optional(),
    timingHidden: z.boolean().optional(),
    timingOriginalStart: z.number().finite().min(0).optional(),
    timingOriginalEnd: z.number().finite().min(0).optional(),
    timingReviewed: z.boolean().optional(),
    // A section transcription's own lines and the lines it replaced, kept so it can be undone.
    sectionRunId: z.string().min(1).max(100).optional(),
    sectionReplacedBy: z.string().min(1).max(100).optional()
  })
  .refine((segment) => segment.end === undefined || segment.end >= segment.start, {
    message: 'Segment end must not precede its start'
  })

const UpdateTranscriptRequestSchema = z
  .object({
    recordingId: RecordingIdSchema,
    expectedFullText: z.string().max(10_000_000),
    /**
     * The stored segments the editor started from (null when there were none).
     * A start-time edit does not change the text, so the text check alone let
     * two editors overwrite each other's times (review 28-sep-2026).
     */
    expectedSegments: z.array(z.unknown()).max(50_000).nullable().optional(),
    segments: z.array(EditableTranscriptSegmentSchema).min(1).max(50_000)
  })
  .superRefine(({ segments }, ctx) => {
    // Start order is not checked: transcription output has lines that start a
    // little before the previous one (overlapping speech), the integrity check
    // reports them as "times go backwards", and rejecting them here made every
    // line of such a transcript impossible to edit (owner, 28-sep-2026).
    let size = 0
    for (const segment of segments) {
      size += segment.text.length + (segment.speaker?.length ?? 0)
    }
    if (size > 10_000_000) {
      ctx.addIssue({ code: 'custom', path: ['segments'], message: 'Transcript is too large' })
    }
  })

type EditableTranscriptSegment = z.infer<typeof EditableTranscriptSegmentSchema>

const CHANNEL_PROVENANCE_KEYS = ['sourceChannel', 'channelRole', 'channelProvenance'] as const

/** The reader edits one line in place. Never accept source evidence from the renderer. */
function preserveStoredChannelProvenance(
  submitted: EditableTranscriptSegment[], stored: unknown[] | null, expected: unknown[] | null | undefined
): EditableTranscriptSegment[] {
  const rows = (stored ?? []).map(row => row && typeof row === 'object' ? row as Record<string, unknown> : {})
  if (!rows.some(row => CHANNEL_PROVENANCE_KEYS.some(key => Object.hasOwn(row, key)))) return submitted
  if (!expected || rows.length !== submitted.length) throw new Error('CHANNEL_EDIT_AMBIGUOUS')
  let changed = 0
  for (let index = 0; index < rows.length; index++) {
    const prior = EditableTranscriptSegmentSchema.safeParse(rows[index])
    if (!prior.success) throw new Error('CHANNEL_EDIT_AMBIGUOUS')
    if (JSON.stringify(prior.data) !== JSON.stringify(submitted[index])) changed++
  }
  // Without persistent segment IDs, multi-line replacement/reordering has no
  // trustworthy source-to-row mapping. The existing editor changes one index.
  if (changed > 1) throw new Error('CHANNEL_EDIT_AMBIGUOUS')
  return submitted.map((segment, index) => ({
    ...segment,
    ...Object.fromEntries(CHANNEL_PROVENANCE_KEYS.filter(key => Object.hasOwn(rows[index], key))
      .map(key => [key, rows[index][key]]))
  }))
}

/** The stored segments as the reader parses them: a non-empty array, or null. */
function storedSegmentsOf(speakers: string | null): unknown[] | null {
  if (!speakers) return null
  try {
    const parsed = JSON.parse(speakers)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
  } catch {
    return null
  }
}

interface TranscriptEditResult {
  fullText: string
  segments: EditableTranscriptSegment[]
  wordCount: number
  indexedChunks: number
  ragStatus: 'indexed' | 'pending'
  ragError?: string
  /** The timing check run again on the saved lines (a time edit can fix or cause a problem). */
  integrity?: { status: string; json: string }
}

function canonicalTranscriptText(segments: EditableTranscriptSegment[]): string {
  return segments
    .filter(segment => !segment.timingHidden)
    .map((segment) => (segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text))
    .join('\n')
}

function safeErrorMessage(err: unknown): string {
  return err instanceof Error && err.message.trim() ? err.message : 'Embedding provider unavailable'
}

/**
 * Index the saved text. With onlyIfCurrent, nothing is generated or written
 * once a newer save changed the transcript, so search never keeps chunks of
 * replaced text (CodeRabbit review of #195).
 */
async function indexCorrectedTranscript(recordingId: string, fullText: string, onlyIfCurrent = false): Promise<number> {
  const recording = getRecordingById(recordingId)
  if (!recording || !isRecordingEligible(recordingId)) throw new Error('Recording is no longer available')

  const meeting = recording.meeting_id
    ? queryOne<{ subject: string | null }>('SELECT subject FROM meetings WHERE id = ?', [recording.meeting_id])
    : undefined
  const isCurrent = () =>
    queryOne<{ full_text: string }>('SELECT full_text FROM transcripts WHERE recording_id = ?', [recordingId])?.full_text === fullText
  const indexedChunks = await getVectorStore().indexTranscript(fullText, {
    meetingId: recording.meeting_id ?? undefined,
    recordingId,
    timestamp: recording.date_recorded ?? recording.created_at,
    subject: meeting?.subject ?? undefined,
    shouldGenerate: () => isRecordingEligible(recordingId) && (!onlyIfCurrent || isCurrent()),
    shouldPersist: () => isRecordingEligible(recordingId) && (!onlyIfCurrent || isCurrent())
  })
  return indexedChunks
}

const ReviewTimingRequestSchema = z.object({
  recordingId: RecordingIdSchema,
  fingerprint: z.string().length(40),
  action: z.enum(['fix_times', 'undo_fix', 'hide', 'show', 'undo_section']),
  findingId: z.string().min(1).max(100).optional(),
  indices: z.array(z.number().int().min(0).max(50_000)).min(1).max(50_000).optional(),
  range: z.object({ from: z.number().int().min(0).max(50_000), to: z.number().int().min(0).max(50_000) })
    .refine((r) => r.to >= r.from, { message: 'Range end must not precede its start' }).optional(),
  runId: z.string().min(1).max(100).optional(),
  // fix_times: the owner pressed "Fix times with Parakeet on the model host".
  useHost: z.boolean().optional()
})

/**
 * Speaker overrides and splits are keyed by rendered turn position. When a
 * section transcription adds or removes turns, every turn from `at` on moves
 * by `by`; with a negative `by`, the turns [at + by, at) were removed and
 * their overrides go with them (CodeRabbit review of #195).
 */
interface TurnShift {
  at: number
  by: number
}

const TURN_KEYED_TABLES = [['turn_speaker_overrides', 'turn_index'], ['speaker_splits', 'from_turn_index']] as const

function shiftTurnKeys(recordingId: string, shift: TurnShift): void {
  if (shift.by === 0) return
  for (const [table, column] of TURN_KEYED_TABLES) {
    if (shift.by < 0) {
      runNoSave(`DELETE FROM ${table} WHERE recording_id = ? AND ${column} >= ? AND ${column} < ?`, [recordingId, shift.at + shift.by, shift.at])
    }
    // Through negative values, so a unique position is never held twice mid-update.
    runNoSave(`UPDATE ${table} SET ${column} = -(${column} + ?) - 1 WHERE recording_id = ? AND ${column} >= ?`, [shift.by, recordingId, shift.at])
    runNoSave(`UPDATE ${table} SET ${column} = -${column} - 1 WHERE recording_id = ? AND ${column} < 0`, [recordingId])
  }
}

const sum = (values: number[]) => values.reduce((total, n) => total + n, 0)

interface TimingSaveResult {
  fullText: string
  segments: TimingSegment[]
  wordCount: number
  integrity?: { status: 'ok' | 'suspect' | 'broken'; json: string }
}

function timingError(err: unknown): Result<never> {
  const message = safeErrorMessage(err)
  if (message === 'TRANSCRIPT_CHANGED') return error('RETRYABLE_ERROR', 'The transcript changed; the review was reloaded')
  if (message === 'RECORDING_INELIGIBLE') return error('RECORDING_INELIGIBLE', 'Recording not available')
  console.warn('[TranscriptTiming] Review failed:', message)
  return error('INTERNAL_ERROR', message)
}

/**
 * Save reviewed lines, then judge and index them again, as a text edit does.
 * Hidden lines stay in the stored segments and leave the text and the index.
 */
async function saveTimingSegments(
  recordingId: string, fingerprint: string, segments: TimingSegment[], turnShift?: TurnShift
): Promise<TimingSaveResult> {
  const fullText = segments.filter((s) => !s.timingHidden).map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n')
  const wordCount = fullText.split(/\s+/u).filter(Boolean).length
  const vectorStore = getVectorStore()
  vectorStore.ensureSchema()
  let transcriptId = ''
  runInTransaction(() => {
    if (!isRecordingEligible(recordingId)) throw new Error('RECORDING_INELIGIBLE')
    const row = queryOne<{ id: string; speakers: string | null }>('SELECT id, speakers FROM transcripts WHERE recording_id = ?', [recordingId])
    if (!row || transcriptFingerprint(row.speakers) !== fingerprint) throw new Error('TRANSCRIPT_CHANGED')
    transcriptId = row.id
    runNoSave('UPDATE transcripts SET speakers = ?, full_text = ?, word_count = ?, validity_version = NULL WHERE id = ?',
      [JSON.stringify(segments), fullText, wordCount, row.id])
    if (turnShift) shiftTurnKeys(recordingId, turnShift)
    runNoSave('DELETE FROM vector_embeddings WHERE recording_id = ?', [recordingId])
  })
  vectorStore.dropByRecordingFromMemory(recordingId)
  let integrity: TimingSaveResult['integrity']
  try {
    const checked = refreshTranscriptIntegrity(transcriptId)
    if (checked) integrity = { status: checked.status, json: JSON.stringify(checked) }
    syncTrustVerdicts(recordingId)
  } catch (err) {
    console.warn('[TranscriptTiming] Saved; the timing check could not run again:', safeErrorMessage(err))
  }
  try {
    await indexCorrectedTranscript(recordingId, fullText, true)
  } catch (err) {
    console.warn(`[TranscriptTiming] Saved ${recordingId}; RAG reindex pending:`, safeErrorMessage(err))
  }
  try {
    exportMeetingWiki(recordingId)
  } catch (err) {
    console.warn('[TranscriptTiming] Meeting wiki refresh failed (non-fatal):', safeErrorMessage(err))
  }
  // Summary, actions and title stay as they are until the owner asks for a new summary.
  return { fullText, segments, wordCount, ...(integrity ? { integrity } : {}) }
}

export function registerTranscriptsHandlers(): void {
  ipcMain.handle('transcripts:getTiming', async (_, request: unknown) => {
    const parsed = z.object({ recordingId: RecordingIdSchema }).safeParse(request)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid timing request')
    try { return success(await getTranscriptTiming(parsed.data.recordingId)) }
    catch (err) { return error('DATABASE_ERROR', safeErrorMessage(err)) }
  })

  // The owner's timing review: fix times, hide or show lines, undo a fix or a
  // section transcription. Each change keeps what it replaced.
  ipcMain.handle('transcripts:reviewTiming', async (_, request: unknown): Promise<Result<TimingSaveResult>> => {
    const parsed = ReviewTimingRequestSchema.safeParse(request)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid timing review', parsed.error.format())
    const { recordingId, fingerprint, action, findingId, indices, range, runId, useHost } = parsed.data
    try {
      if (!isRecordingEligible(recordingId)) return error('RECORDING_INELIGIBLE', 'Recording not available')
      const state = await loadTimingState(recordingId)
      if (state.assessment.fingerprint !== fingerprint) return error('RETRYABLE_ERROR', 'The transcript changed; the review was reloaded')
      const finding = findingId ? state.assessment.findings.find((f) => f.id === findingId) : undefined
      if (findingId && !finding) return error('RETRYABLE_ERROR', 'This problem is no longer in the transcript')
      let review: TimingReviewRequest
      let turnShift: TurnShift | undefined
      if (action === 'fix_times') {
        if (!finding || finding.kind === 'duplicate') return error('VALIDATION_ERROR', 'Choose a line or section out of order')
        if (finding.windowStart === null || finding.windowEnd === null) return error('VALIDATION_ERROR', finding.fix?.reason ?? 'Where these lines belong is unknown')
        const lines = finding.lines.map((i) => state.segments[i])
        const window = { start: finding.windowStart, end: finding.windowEnd }
        // The model host first (the owner's choice, 26-nov-2026): Parakeet hears the words in
        // this window only. Lines holding their own timed turns never go; moving them moves nothing.
        // Audio leaves this computer only when the owner pressed the model host's button,
        // which says so (Kiro review of #198).
        const host = !useHost
          ? { used: false as const, reason: 'The model host was not asked.' }
          : lines.some((s) => hasInlineTurns(s.text))
          ? { used: false as const, reason: 'This line holds turns with their own times.' }
          : await fixTimesOnModelHost({ recordingId, audioPath: state.filePath, lines, window, durationSeconds: state.durationSeconds })
        if (host.used) {
          review = { action, indices: finding.lines, alignment: host.alignment, method: 'model-host-words' }
        } else {
          console.info(`[TranscriptTiming] Fix times on this computer for ${recordingId}: ${host.reason}`)
          const spans = state.evidence.spansIn(window.start, window.end)
          if (!spans) return error('VALIDATION_ERROR', `This recording has no speech evidence to place the lines on. ${host.reason}`, { lowConfidence: true, hostReason: host.reason })
          const alignment = alignToSpeech(lines, window, spans)
          if (!alignment.ok) return error('VALIDATION_ERROR', `${alignment.reason} ${host.reason}`, { lowConfidence: true, confidence: alignment.confidence, hostReason: host.reason })
          review = { action, indices: finding.lines, alignment, method: state.assessment.evidence ?? 'vad' }
        }
      } else if (action === 'hide' || action === 'show') {
        const chosen = indices ?? finding?.lines
        if (!chosen?.length) return error('VALIDATION_ERROR', 'Choose the lines')
        review = { action, indices: chosen }
      } else if (action === 'undo_fix') {
        if (!range) return error('VALIDATION_ERROR', 'Choose the fixed lines')
        review = { action, range }
      } else {
        if (!runId) return error('VALIDATION_ERROR', 'Choose the section transcription')
        review = { action, runId }
        // The run's own turns go away; the turns after them move back.
        const counts = renderedTurnCounts(state.segments)
        const rows = state.segments.flatMap((s, i) => s.sectionRunId === runId ? [i] : [])
        if (rows.length) {
          const removed = sum(rows.map((i) => counts[i]))
          turnShift = { at: sum(counts.slice(0, rows[0])) + removed, by: -removed }
        }
      }
      return success(await saveTimingSegments(recordingId, fingerprint, applyTimingReview(state.segments, review), turnShift))
    } catch (err) {
      return timingError(err)
    }
  })

  // "Transcribe this section again": only after the owner confirmed it in the
  // reader. Sends only the audio between the trusted lines around the range.
  ipcMain.handle('transcripts:retranscribeSection', async (_, request: unknown): Promise<Result<TimingSaveResult>> => {
    const parsed = z.object({ recordingId: RecordingIdSchema, fingerprint: z.string().length(40), findingId: z.string().min(1).max(100) }).safeParse(request)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid section request', parsed.error.format())
    const { recordingId, fingerprint, findingId } = parsed.data
    try {
      if (!isRecordingEligible(recordingId)) return error('RECORDING_INELIGIBLE', 'Recording not available')
      const state = await loadTimingState(recordingId)
      if (state.assessment.fingerprint !== fingerprint) return error('RETRYABLE_ERROR', 'The transcript changed; the review was reloaded')
      const finding = state.assessment.findings.find((f) => f.id === findingId)
      if (!finding || finding.kind === 'duplicate') return error('RETRYABLE_ERROR', 'This section is no longer out of order')
      if (finding.windowStart === null || finding.windowEnd === null) return error('VALIDATION_ERROR', 'Where this section belongs is unknown')
      // Lines a second or two off are speech overlapping; a paid transcription cannot improve them.
      if ((finding.fix?.displacement ?? 0) < OVERLAP_SECONDS) return error('VALIDATION_ERROR', 'These lines are where they belong, give or take two people talking at once')
      const { transcribeRecordingSection } = await import('../services/transcription')
      const section = await transcribeRecordingSection(recordingId, finding.windowStart, finding.windowEnd, state.durationSeconds)
      // The new lines go in after the hidden old ones: every later turn moves by their count.
      const counts = renderedTurnCounts(state.segments)
      const turnShift = { at: sum(counts.slice(0, finding.to + 1)), by: sum(renderedTurnCounts(section.segments)) }
      return success(await saveTimingSegments(recordingId, fingerprint,
        spliceSection(state.segments, finding.from, finding.to, section.segments, section.runId), turnShift))
    } catch (err) {
      return timingError(err)
    }
  })

  ipcMain.handle('transcripts:getDiarizedSegments', async (_, request: unknown) => {
    const parsed = GetSpeakerMapRequestSchema.safeParse(request)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid recording request')
    const recording = getRecordingById(parsed.data.recordingId) ?? resolveRecordingId(parsed.data.recordingId)
    if (!recording) return error('NOT_FOUND', 'Recording not found')
    try { return success(getDiarizedSegments(recording.id)) }
    catch (err) { return error('DATABASE_ERROR', 'Could not read diarized segments', err) }
  })

  // The owner's "Generate summary": the missing summary, title and meeting
  // choice now, through the same brains and order, without the automatic
  // retry's wait or weekly cap (28-oct-2026).
  ipcMain.handle('transcripts:retrySummary', async (_, request: unknown): Promise<Result<{ written: boolean }>> => {
    const parsed = GetSpeakerMapRequestSchema.safeParse(request)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid summary retry request', parsed.error.format())
    try {
      if (!isRecordingEligible(parsed.data.recordingId)) return error('NOT_FOUND', 'Recording is not available for a summary')
      return success({ written: await retrySummary(parsed.data.recordingId) })
    } catch (err) {
      return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Summary retry failed', err)
    }
  })

  ipcMain.handle('transcripts:getProcessingRuns', async (_, request: unknown) => {
    const parsed = GetSpeakerMapRequestSchema.safeParse(request)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid processing-runs request', parsed.error.format())
    try {
      if (!getRecordingById(parsed.data.recordingId)) return success([])
      return success(getActiveProcessingRunsForRecording(parsed.data.recordingId))
    } catch (err) {
      return error('DATABASE_ERROR', 'Failed to fetch processing provenance', err)
    }
  })

  /**
   * Bind a speaker label to a contact (existing contactId or a newName to upsert).
   */
  ipcMain.handle('transcripts:assignSpeaker', async (_, request: unknown): Promise<Result<Contact>> => {
    try {
      const parsed = AssignSpeakerRequestSchema.safeParse(request)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', 'Invalid assignSpeaker request', parsed.error.format())
      }

      const { recordingId, speakerLabel, contactId, newName } = parsed.data
      const contact = assignSpeaker(recordingId, speakerLabel, {
        contactId,
        newName,
        voiceAnchor: { method: 'manual', confidence: 1 },
        source: 'manual',
        confidence: 1
      })
      try {
        const consolidated = consolidateVoiceIdentityForSpeaker(recordingId, speakerLabel, contact.id)
        if (consolidated.mergedClusterIds.length) {
          console.info(
            `[VoiceID] Consolidated ${consolidated.mergedClusterIds.length} acoustic duplicate(s) for ${contact.id}`
          )
        }
      } catch (consolidationError) {
        // The explicit person assignment already committed and remains valid.
        // Report repair failure without lying to the user that the assignment failed.
        console.warn('[VoiceID] Person assigned; historical voice consolidation failed:', consolidationError)
      }
      return success(contact)
    } catch (err) {
      console.error('transcripts:assignSpeaker error:', err)
      return error('DATABASE_ERROR', 'Failed to assign speaker', err)
    }
  })

  /**
   * Get the speaker-label → contact map for a recording.
   */
  ipcMain.handle('transcripts:getSpeakerMap', async (_, request: unknown): Promise<Result<SpeakerMapEntry[]>> => {
    try {
      const parsed = GetSpeakerMapRequestSchema.safeParse(request)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', 'Invalid getSpeakerMap request', parsed.error.format())
      }

      return success(getSpeakerMap(parsed.data.recordingId))
    } catch (err) {
      console.error('transcripts:getSpeakerMap error:', err)
      return error('DATABASE_ERROR', 'Failed to fetch speaker map', err)
    }
  })

  /**
   * Remove a speaker-label → contact binding.
   */
  ipcMain.handle('transcripts:unassignSpeaker', async (_, request: unknown): Promise<Result<void>> => {
    try {
      const parsed = UnassignSpeakerRequestSchema.safeParse(request)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', 'Invalid unassignSpeaker request', parsed.error.format())
      }

      unassignSpeaker(parsed.data.recordingId, parsed.data.speakerLabel)
      return success(undefined)
    } catch (err) {
      console.error('transcripts:unassignSpeaker error:', err)
      return error('DATABASE_ERROR', 'Failed to unassign speaker', err)
    }
  })

  /**
   * Persist a user-corrected transcript and invalidate its old semantic index in
   * one SQLite transaction. Re-embedding follows immediately. A provider failure
   * is reported as an honest, retryable RAG-pending state; stale chunks are never
   * left searchable after corrected source text has committed.
   */
  ipcMain.handle(
    'transcripts:updateContent',
    async (_, request: unknown): Promise<Result<TranscriptEditResult>> => {
      const parsed = UpdateTranscriptRequestSchema.safeParse(request)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', 'Invalid transcript edit', parsed.error.format())
      }

      try {
        const canonical = getRecordingById(parsed.data.recordingId) ?? resolveRecordingId(parsed.data.recordingId)
        const recordingId = canonical?.id ?? parsed.data.recordingId
        if (!isRecordingEligible(recordingId)) return error('RECORDING_INELIGIBLE', 'Recording not available')

        const fullText = canonicalTranscriptText(parsed.data.segments)
        const wordCount = fullText.split(/\s+/u).filter(Boolean).length
        let savedSegments = parsed.data.segments
        const vectorStore = getVectorStore()
        vectorStore.ensureSchema()

        runInTransaction(() => {
          if (!isRecordingEligible(recordingId)) throw new Error('RECORDING_INELIGIBLE')
          const current = queryOne<{ full_text: string; speakers: string | null }>(
            'SELECT full_text, speakers FROM transcripts WHERE recording_id = ?',
            [recordingId]
          )
          if (!current) throw new Error('TRANSCRIPT_NOT_FOUND')
          if (current.full_text !== parsed.data.expectedFullText) throw new Error('TRANSCRIPT_CHANGED')
          if (
            parsed.data.expectedSegments !== undefined &&
            JSON.stringify(parsed.data.expectedSegments) !== JSON.stringify(storedSegmentsOf(current.speakers))
          ) {
            throw new Error('TRANSCRIPT_CHANGED')
          }

          savedSegments = preserveStoredChannelProvenance(
            parsed.data.segments, storedSegmentsOf(current.speakers), parsed.data.expectedSegments
          )
          runNoSave(
            'UPDATE transcripts SET full_text = ?, speakers = ?, word_count = ? WHERE recording_id = ?',
            [fullText, JSON.stringify(savedSegments), wordCount, recordingId]
          )
          runNoSave('DELETE FROM vector_embeddings WHERE recording_id = ?', [recordingId])
        })
        vectorStore.dropByRecordingFromMemory(recordingId)

        // The warning is about these lines' times, so it is judged again on
        // what was saved. Edits used to skip this, and a fixed line kept its
        // warning with jump buttons that found nothing (28-sep-2026).
        let integrity: TranscriptEditResult['integrity']
        try {
          const saved = queryOne<{ id: string }>('SELECT id FROM transcripts WHERE recording_id = ?', [recordingId])
          const checked = saved ? refreshTranscriptIntegrity(saved.id) : null
          if (checked) integrity = { status: checked.status, json: JSON.stringify(checked) }
          syncTrustVerdicts(recordingId)
        } catch (err) {
          console.warn('[TranscriptEdit] Saved; the timing check could not run again:', safeErrorMessage(err))
        }

        let indexedChunks = 0
        let ragStatus: TranscriptEditResult['ragStatus'] = 'indexed'
        let ragError: string | undefined
        try {
          indexedChunks = await indexCorrectedTranscript(recordingId, fullText)
        } catch (err) {
          ragStatus = 'pending'
          ragError = safeErrorMessage(err)
          console.warn(`[TranscriptEdit] Saved ${recordingId}; RAG reindex pending:`, ragError)
        }

        try {
          exportMeetingWiki(recordingId)
        } catch (err) {
          console.warn('[TranscriptEdit] Meeting wiki refresh failed (non-fatal):', safeErrorMessage(err))
        }

        return success({
          fullText,
          segments: savedSegments,
          wordCount,
          indexedChunks,
          ragStatus,
          ...(ragError ? { ragError } : {}),
          ...(integrity ? { integrity } : {})
        })
      } catch (err) {
        const message = safeErrorMessage(err)
        if (message === 'CHANNEL_EDIT_AMBIGUOUS') {
          return error('VALIDATION_ERROR', 'Channel transcript edits must change one existing line without adding, removing or reordering lines. Reload and edit one line at a time.')
        }
        if (message === 'TRANSCRIPT_CHANGED') {
          return error('RETRYABLE_ERROR', 'The transcript changed while you were editing. Reload it and try again.')
        }
        if (message === 'TRANSCRIPT_NOT_FOUND') return error('NOT_FOUND', 'Transcript not found')
        if (message === 'RECORDING_INELIGIBLE') {
          return error('RECORDING_INELIGIBLE', 'Recording not available')
        }
        console.error('transcripts:updateContent error:', err)
        return error('DATABASE_ERROR', 'Failed to save transcript correction', message)
      }
    }
  )

  ipcMain.handle(
    'transcripts:reindex',
    async (_, request: unknown): Promise<Result<{ indexedChunks: number }>> => {
      const parsed = GetSpeakerMapRequestSchema.safeParse(request)
      if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid transcript reindex request', parsed.error.format())

      try {
        const canonical = getRecordingById(parsed.data.recordingId) ?? resolveRecordingId(parsed.data.recordingId)
        const recordingId = canonical?.id ?? parsed.data.recordingId
        if (!isRecordingEligible(recordingId)) return error('RECORDING_INELIGIBLE', 'Recording not available')
        const transcript = queryOne<{ full_text: string }>(
          'SELECT full_text FROM transcripts WHERE recording_id = ?',
          [recordingId]
        )
        if (!transcript?.full_text.trim()) return error('NOT_FOUND', 'Transcript not found')

        // Replace changed chunks only after their new vectors exist; preserve other providers.
        const indexedChunks = await indexCorrectedTranscript(recordingId, transcript.full_text)
        return success({ indexedChunks })
      } catch (err) {
        const message = safeErrorMessage(err)
        console.warn('transcripts:reindex error:', message)
        return error('SERVICE_UNAVAILABLE', 'Transcript is saved, but the RAG index could not be updated', message)
      }
    }
  )

  /**
   * Edit ONE element of the transcript's extracted action_items / key_points
   * JSON arrays (2026-07-22 — reader event-list editability for
   * transcript-derived items, refIds `txa_<i>` / `txk_<i>`).
   *
   * Gating (ADV17/38 lineage): the recording must be eligible BEFORE the read
   * AND the write — an excluded recording's extracted text is neither read nor
   * mutated. Index-addressed: a concurrent retranscription that rewrites the
   * arrays between read and write is detected by re-reading inside the same
   * synchronous statement sequence (sql.js is single-writer; there is no await
   * between the eligibility check, the bounds check, and the UPDATE).
   */
  ipcMain.handle(
    'transcripts:updateExtractedItem',
    async (_, request: unknown): Promise<Result<{ kind: 'action' | 'decision'; index: number; content: string }>> => {
      try {
        const parsed = UpdateExtractedItemRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid updateExtractedItem request', parsed.error.format())
        }
        const { recordingId, kind, index, content } = parsed.data

        const canonical = getRecordingById(recordingId) ?? resolveRecordingId(recordingId)
        const id = canonical?.id ?? recordingId
        if (!isRecordingEligible(id)) {
          return error('RECORDING_INELIGIBLE', 'Recording not available')
        }

        const column = kind === 'action' ? 'action_items' : 'key_points'
        const row = queryOne<{ v: string | null }>(
          `SELECT ${column} AS v FROM transcripts WHERE recording_id = ?`,
          [id]
        )
        if (!row) {
          return error('NOT_FOUND', 'Transcript not found')
        }
        let arr: unknown
        try {
          arr = JSON.parse(row.v ?? '[]')
        } catch {
          arr = []
        }
        if (!Array.isArray(arr) || index >= arr.length || typeof arr[index] !== 'string') {
          return error('NOT_FOUND', 'Extracted item not found at index')
        }
        arr[index] = content
        run(`UPDATE transcripts SET ${column} = ? WHERE recording_id = ?`, [JSON.stringify(arr), id])
        return success({ kind, index, content })
      } catch (err) {
        console.error('transcripts:updateExtractedItem error:', err)
        return error('DATABASE_ERROR', 'Failed to update extracted item', err)
      }
    }
  )
}
