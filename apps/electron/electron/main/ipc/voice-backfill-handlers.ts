/**
 * Voice evidence for older recordings (spec 2026-10-03, section 1b): Settings reads the
 * progress and measures one recording now. Gated with transcription (the `voice-backfill:`
 * namespace). Neither channel takes input.
 */

import { ipcMain } from 'electron'
import {
  getVoiceBackfillStatus,
  measureOneRecording,
  type VoiceBackfillMeasure,
  type VoiceBackfillStatus
} from '../services/voice-backfill'
import { success, error, type Result } from '../types/api'

export function registerVoiceBackfillHandlers(): void {
  ipcMain.handle('voice-backfill:getStatus', async (): Promise<Result<VoiceBackfillStatus>> => {
    try {
      return success(getVoiceBackfillStatus())
    } catch (e) {
      console.error('[voice-backfill:getStatus]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not read the progress')
    }
  })

  // Runs the next recording now, regardless of the night window, and times it.
  ipcMain.handle('voice-backfill:measureOne', async (): Promise<Result<VoiceBackfillMeasure>> => {
    try {
      return success(await measureOneRecording())
    } catch (e) {
      console.error('[voice-backfill:measureOne]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not measure a recording')
    }
  })
}
