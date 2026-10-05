/**
 * Clipboard Capture IPC Handlers
 *
 * Channels:
 *   clipboard:captureImage()          → capture the current clipboard image as an image capture
 *   clipboard:setAutoWatch(enabled)   → start/stop the background clipboard poll
 *   clipboard:isWatchActive()         → query watch state
 *
 * Push event (main → renderer):
 *   clipboard:captured                → emitted when the auto-watch adds a capture
 */

import { ipcMain, BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import { pasteLibrary, newLibraryNote } from '../services/paste-library-runtime'
import {
  captureClipboardImage,
  startClipboardWatch,
  stopClipboardWatch,
  isClipboardWatchActive,
  type ClipboardCaptureResult
} from '../services/clipboard-capture'

function broadcastCapture(result: ClipboardCaptureResult): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('clipboard:captured', result)
    }
  }
}

export function registerClipboardCaptureHandlers(): void {
  const snapshotSchema = z.object({
    files: z.array(z.string().min(1).max(32768)).max(100).optional(),
    text: z.string().max(1024 * 1024).optional(),
    png: z.instanceof(Uint8Array).refine((bytes) => bytes.length <= 25 * 1024 * 1024).optional()
  }).strict()
  ipcMain.handle('library:paste', async (_event, snapshot: unknown) => {
    try { return await pasteLibrary(snapshot === undefined ? undefined : snapshotSchema.parse(snapshot)) }
    catch (error) { return [{ title: 'Clipboard', error: error instanceof Error ? error.message : String(error) }] }
  })
  ipcMain.handle('library:pickFiles', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import to Library', properties: ['openFile', 'multiSelections'], filters: [{ name: 'All files', extensions: ['*'] }] })
    return result.canceled ? [] : pasteLibrary({ files: result.filePaths })
  })
  ipcMain.handle('library:newNote', () => newLibraryNote())
  ipcMain.handle('clipboard:captureImage', async (): Promise<ClipboardCaptureResult> => {
    return captureClipboardImage()
  })

  ipcMain.handle('clipboard:setAutoWatch', async (_event, enabled: unknown): Promise<{ active: boolean }> => {
    if (enabled === true) {
      startClipboardWatch({ onCapture: broadcastCapture })
    } else {
      stopClipboardWatch()
    }
    return { active: isClipboardWatchActive() }
  })

  ipcMain.handle('clipboard:isWatchActive', async (): Promise<{ active: boolean }> => {
    return { active: isClipboardWatchActive() }
  })
}
