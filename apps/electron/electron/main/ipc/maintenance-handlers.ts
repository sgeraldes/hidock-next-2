/**
 * Library maintenance IPC: the Settings maintenance card (owner, 28-sep-2026).
 * Core (library floor): each job works on stored data. Relinking also asks a
 * connected Microsoft 365 account for past meetings and simply skips when none
 * is connected.
 */

import { ipcMain } from 'electron'
import { success, error, type Result } from '../types/api'
import {
  markEvaluationsOutdated,
  recheckWarnings,
  redrawWaveforms,
  relinkRecordingsToMeetings,
  type RelinkResult,
  type WaveformRedrawResult
} from '../services/library-maintenance'

export function registerMaintenanceHandlers(): void {
  ipcMain.handle('maintenance:recheckWarnings', async (): Promise<Result<{ changed: number; evaluated: number }>> => {
    try {
      return success(await recheckWarnings())
    } catch (e) {
      console.error('[maintenance:recheckWarnings]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not re-check the warnings')
    }
  })

  ipcMain.handle('maintenance:relinkMeetings', async (): Promise<Result<RelinkResult>> => {
    try {
      return success(await relinkRecordingsToMeetings())
    } catch (e) {
      console.error('[maintenance:relinkMeetings]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not relink recordings')
    }
  })

  ipcMain.handle('maintenance:redrawWaveforms', async (): Promise<Result<WaveformRedrawResult>> => {
    try {
      const result = await redrawWaveforms()
      if ('busy' in result) return error('RETRYABLE_ERROR', 'Waveforms are already being drawn.')
      return success(result)
    } catch (e) {
      console.error('[maintenance:redrawWaveforms]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not draw the waveforms')
    }
  })

  // Rescan with Jev, every recording: mark the stored evaluations outdated. The
  // renderer then starts the value backfill, which evaluates them again.
  ipcMain.handle('maintenance:markEvaluationsOutdated', async (): Promise<Result<{ marked: number }>> => {
    try {
      return success({ marked: markEvaluationsOutdated() })
    } catch (e) {
      console.error('[maintenance:markEvaluationsOutdated]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not mark the evaluations')
    }
  })
}
