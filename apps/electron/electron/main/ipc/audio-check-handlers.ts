/**
 * Audio check IPC: check one recording again now, or run the pass over the
 * library on request. Core (library floor): checking audio needs no provider,
 * no network and no feature.
 *
 * Spec: docs/superpowers/specs/2026-09-24-recording-checks-design.md
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import { backfillAudioProfiles, getAudioProfile, profileRecordingNow } from '../services/audio-profile-store'
import { success, error, type Result } from '../types/api'
import type { AudioCheckResult } from '../../../src/types/audio'

const RecordingIdSchema = z.string().min(1).max(200)

export function registerAudioCheckHandlers(): void {
  ipcMain.handle('audio:checkRecording', async (_, recordingId: unknown): Promise<Result<AudioCheckResult>> => {
    const parsed = RecordingIdSchema.safeParse(recordingId)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid recording id')
    try {
      const outcome = await profileRecordingNow(parsed.data)
      if (!outcome.profile) return error('NOT_FOUND', 'The audio file for this recording is not on this computer.')
      const p = outcome.profile
      return success({
        category: p.category,
        durationSeconds: p.durationSeconds,
        soundSeconds: p.soundSeconds,
        soundShare: p.soundShare,
        longestSoundSeconds: p.longestSoundSeconds,
        spikeCount: p.spikeCount,
        ranges: p.ranges,
        capturesRated: outcome.capturesRated,
      })
    } catch (e) {
      console.error('[audio:checkRecording]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not check the audio')
    }
  })

  ipcMain.handle('audio:getCheck', async (_, recordingId: unknown): Promise<Result<AudioCheckResult | null>> => {
    const parsed = RecordingIdSchema.safeParse(recordingId)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid recording id')
    const row = getAudioProfile(parsed.data)
    if (!row) return success(null)
    let ranges: { start: number; end: number }[] = []
    try {
      ranges = row.ranges_json ? JSON.parse(row.ranges_json) : []
    } catch {
      ranges = []
    }
    return success({
      category: row.category,
      durationSeconds: row.duration_seconds ?? 0,
      soundSeconds: row.sound_seconds ?? 0,
      soundShare: row.sound_share ?? 0,
      longestSoundSeconds: row.longest_sound_seconds ?? 0,
      spikeCount: row.spike_count ?? 0,
      ranges,
      capturesRated: 0,
    })
  })

  // Runs in the background; the result arrives as the audio:profiles-updated event.
  ipcMain.handle('audio:checkLibrary', async (): Promise<Result<{ started: boolean }>> => {
    void backfillAudioProfiles().catch((e) => console.error('[audio:checkLibrary]', e))
    return success({ started: true })
  })
}
