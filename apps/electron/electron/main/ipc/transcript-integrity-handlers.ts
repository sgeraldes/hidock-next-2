/**
 * The two ways back to green for a transcript flagged by the integrity check.
 *
 * Automatic: queue a new transcription. The new transcript is checked as it is
 * stored (insertTranscript), so a clean run turns the label green by itself.
 * Manual: the owner accepts the transcript as it is. That survives rechecks
 * under the same rules and ends when the transcript is replaced.
 *
 * Both channels live under `transcripts:`, which the transcription feature
 * gates: with transcription off there is nothing to re-run.
 *
 * Spec: docs/superpowers/specs/2026-09-23-transcript-integrity-design.md
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import { addToQueue, resolveRecordingId, setTranscriptIntegrityAccepted } from '../services/database'
import { processQueueManually } from '../services/transcription'
import { success, error, type Result } from '../types/api'

const RecordingIdSchema = z.string().min(1).max(200)

const SetAcceptedSchema = z.object({
  recordingId: RecordingIdSchema,
  accepted: z.boolean(),
})

/** Enough for the whole library at once, bounded so a bad caller cannot flood the queue. */
export const MAX_RETRANSCRIBE_BATCH = 5000

const RetranscribeSchema = z.object({
  recordingIds: z.array(RecordingIdSchema).min(1).max(MAX_RETRANSCRIBE_BATCH),
})

export interface RetranscribeResult {
  queued: number
  /** Not found, or not eligible (personal, deleted, already queued). */
  skipped: number
}

export function registerTranscriptIntegrityHandlers(): void {
  ipcMain.handle('transcripts:setIntegrityAccepted', async (_, payload: unknown): Promise<Result<{ accepted: boolean }>> => {
    const parsed = SetAcceptedSchema.safeParse(payload)
    if (!parsed.success) return error('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request')
    const recording = resolveRecordingId(parsed.data.recordingId)
    if (!recording) return error('NOT_FOUND', 'Recording not found')
    if (!setTranscriptIntegrityAccepted(recording.id, parsed.data.accepted)) {
      return error('NOT_FOUND', 'This recording has no transcript')
    }
    return success({ accepted: parsed.data.accepted })
  })

  ipcMain.handle('transcripts:retranscribeMany', async (_, payload: unknown): Promise<Result<RetranscribeResult>> => {
    const parsed = RetranscribeSchema.safeParse(payload)
    if (!parsed.success) return error('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request')
    let queued = 0
    let skipped = 0
    for (const id of new Set(parsed.data.recordingIds)) {
      const recording = resolveRecordingId(id)
      // addToQueue refuses personal and deleted recordings and ones already queued.
      if (recording && addToQueue(recording.id)) queued++
      else skipped++
    }
    // Queued in the normal order, not ahead of the owner's own requests: a
    // library-wide re-run should not push a single explicit re-transcribe back.
    if (queued > 0) processQueueManually()
    return success({ queued, skipped })
  })
}
