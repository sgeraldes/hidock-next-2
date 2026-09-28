import { ipcMain } from 'electron'
import { statSync } from 'fs'
import { queryOne } from '../services/database'
import {
  getWaveformCache,
  setWaveformCache,
  clearWaveformCache
} from '../services/waveform-cache'

/**
 * IPC handlers for the disk-backed waveform peak cache.
 * See electron/main/services/waveform-cache.ts.
 */
export function registerWaveformCacheHandlers(): void {
  ipcMain.handle('waveform:getCache', async (_event, recordingId: string, fileSize?: number) => {
    return getWaveformCache(recordingId, fileSize ?? currentFileSize(recordingId))
  })

  ipcMain.handle(
    'waveform:setCache',
    async (_event, recordingId: string, peaks: number[], duration?: number, fileSize?: number) => {
      return setWaveformCache(recordingId, peaks, duration ?? 0, fileSize ?? 0)
    }
  )

  ipcMain.handle('waveform:clearCache', async (_event, recordingId: string) => {
    return clearWaveformCache(recordingId)
  })

  console.log('[WaveformCache] IPC handlers registered')
}

/** Size of the recording's audio file on disk now, or undefined when unknown. */
function currentFileSize(recordingId: string): number | undefined {
  try {
    const row = queryOne<{ file_path: string | null }>('SELECT file_path FROM recordings WHERE id = ?', [recordingId])
    return row?.file_path ? statSync(row.file_path).size : undefined
  } catch {
    return undefined
  }
}
