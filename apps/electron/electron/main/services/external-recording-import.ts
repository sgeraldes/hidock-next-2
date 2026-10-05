import { copyFileSync, existsSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { RECORDING_AUDIO_EXTENSIONS } from '../../../src/shared/audio-extensions'
import { getRecordingById, getRecordingByFilename, insertRecording, type Recording } from './database'
import { getRecordingsPath } from './file-storage'
import { parseHiDockFilenameDateIso } from './hidock-filename'
import { BrowserWindow } from 'electron'

/** The recordings:addExternalByPath import path, shared with PC capture/recovery.
 * PC filenames include a UUID, so re-import after an interrupted cleanup is idempotent.
 * Import itself does not start a provider or upload audio.
 */
export function importExternalRecording(filePath: string, options: { preserveFilename?: boolean } = {}): {
  success: boolean; recording?: Recording; error?: string
} {
  try {
    const extension = extname(filePath).toLowerCase()
    if (!(RECORDING_AUDIO_EXTENSIONS as readonly string[]).includes(extension)) {
      return { success: false, error: `Unsupported file type: ${extension}. Supported: ${RECORDING_AUDIO_EXTENSIONS.join(', ')}` }
    }
    if (!existsSync(filePath)) return { success: false, error: 'File does not exist' }
    const originalFilename = basename(filePath)
    const id = randomUUID()
    const filename = options.preserveFilename ? originalFilename : `external-${id}${extension}`
    if (options.preserveFilename) {
      const existing = getRecordingByFilename(filename)
      if (existing) return { success: true, recording: existing }
    }
    const stats = statSync(filePath)
    const destination = join(getRecordingsPath(), filename)
    copyFileSync(filePath, destination)
    insertRecording({
      id, filename, original_filename: originalFilename, file_path: destination,
      file_size: stats.size, duration_seconds: undefined,
      date_recorded: parseHiDockFilenameDateIso(originalFilename) ?? stats.mtime.toISOString(),
      meeting_id: undefined, correlation_confidence: undefined, correlation_method: undefined,
      status: 'ready', location: 'local-only', transcription_status: 'none', on_device: 0,
      device_last_seen: undefined, on_local: 1, source: 'external', is_imported: 1
    })
    const recording = getRecordingById(id)
    if (!recording) return { success: false, error: 'Failed to retrieve recording after insert' }
    if (options.preserveFilename) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('recording:new', { recording })
      }
    }
    return { success: true, recording }
  } catch (error) {
    console.error('recordings:addExternalByPath error:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
