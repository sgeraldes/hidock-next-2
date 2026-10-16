/**
 * Transcription queue-control IPC handlers.
 *
 * These expose the MAIN-PROCESS transcription queue processor to the renderer's
 * Operations dock:
 *
 *   - transcription:pause / transcription:resume  Queue-level pause. Pause stops
 *       DEQUEUING new items; an item already in flight finishes normally (a live
 *       model request cannot be aborted mid-call). Resume continues where it left.
 *   - transcription:reorder                       Apply a user prioritize (up) or
 *       deprioritize (down) intent. Main is the source of truth for the actual
 *       processing order (queuePriorityRank); it echoes queue state back so every
 *       renderer reflects the change.
 *   - transcription:queueState                    Pull the current queue snapshot
 *       (paused? which id is processing? pending/processing counts). Main also
 *       PUSHES this same shape on 'transcription:queueState' whenever it changes.
 *   - transcription:engineAvailability            The engine chain from Settings and
 *       whether each engine could run now (key present, host answering, runner found).
 *   - transcription:attempts                      Every engine attempt of one recording.
 *
 * (The pre-existing transcription:cancel / cancelAll / getQueue / updateQueueItem
 * channels live in recording-handlers.ts and are unchanged.)
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  pauseQueue,
  resumeQueue,
  reorderQueueItem,
  getQueueState,
  restartLocalStage,
  getEngineChainAvailability,
  getTranscriptionAttempts,
  type TranscriptionQueueState
} from '../services/transcription'
import type { EngineAvailability, TranscriptionAttemptView } from '../../../src/shared/transcription-engines'
import { importCompletedRemoteJobReceipt, type CompletedRemoteJobReceipt } from '../services/remote-job-recovery'
import { STORED_AUDIO_TRANSFORM_VERSION } from '../services/stored-audio-channels'

const ReorderSchema = z.object({
  recordingId: z.string().min(1).max(200),
  direction: z.enum(['up', 'down'])
})

const CompletedRemoteJobReceiptSchema = z.object({
  localRecordingId: z.string().min(1).max(200),
  expectedRemoteRecordingId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  base: z.string().min(1).max(2048),
  jobId: z.string().uuid(),
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
  sourceAudioHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTrackId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceChannelIndex: z.literal(1),
  transformVersion: z.literal(STORED_AUDIO_TRANSFORM_VERSION)
}).strict()

export function registerTranscriptionHandlers(): void {
  ipcMain.handle('transcription:importCompletedRemoteJobReceipt', async (_, request: unknown) => {
    const parsed = CompletedRemoteJobReceiptSchema.safeParse(request)
    if (!parsed.success) return { success: false, error: 'Invalid completed remote job receipt' }
    try {
      const imported = await importCompletedRemoteJobReceipt(parsed.data as CompletedRemoteJobReceipt)
      return { success: true, ...imported }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('transcription:restartLocalStage', async (_, recordingId: unknown) => {
    try {
      const id = z.string().min(1).max(200).parse(recordingId)
      await restartLocalStage(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('transcription:pause', async (): Promise<TranscriptionQueueState> => {
    try {
      return pauseQueue()
    } catch (error) {
      console.error('transcription:pause error:', error)
      return getQueueState()
    }
  })

  ipcMain.handle('transcription:resume', async (): Promise<TranscriptionQueueState> => {
    try {
      return resumeQueue()
    } catch (error) {
      console.error('transcription:resume error:', error)
      return getQueueState()
    }
  })

  ipcMain.handle('transcription:reorder', async (_, request: unknown): Promise<TranscriptionQueueState> => {
    try {
      const parsed = ReorderSchema.safeParse(request)
      if (!parsed.success) {
        console.error('transcription:reorder validation error:', parsed.error.format())
        return getQueueState()
      }
      reorderQueueItem(parsed.data.recordingId, parsed.data.direction)
      return getQueueState()
    } catch (error) {
      console.error('transcription:reorder error:', error)
      return getQueueState()
    }
  })

  ipcMain.handle('transcription:queueState', async (): Promise<TranscriptionQueueState> => {
    try {
      return getQueueState()
    } catch (error) {
      console.error('transcription:queueState error:', error)
      return { paused: false, isProcessing: false, processingId: null, shortLaneId: null, pendingCount: 0, processingCount: 0 }
    }
  })

  ipcMain.handle('transcription:engineAvailability', async (): Promise<EngineAvailability[]> => {
    return getEngineChainAvailability()
  })

  ipcMain.handle('transcription:attempts', async (_, recordingId: unknown): Promise<TranscriptionAttemptView[]> => {
    const id = z.string().min(1).max(200).parse(recordingId)
    return getTranscriptionAttempts(id).map(({ queueItemId: _queueItemId, ...attempt }) => attempt)
  })
}
