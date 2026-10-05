import { app, ipcMain, desktopCapturer, type BrowserWindow } from 'electron'
import { join } from 'path'
import { PcRecorder } from '../services/pc-recorder'
import { importExternalRecording } from '../services/external-recording-import'

let requestStop: (() => Promise<void>) | null = null
let quitting = false
export async function stopPcRecorderBeforeQuit(): Promise<void> { quitting = true; await requestStop?.() }

/** Installed only on the main window's session. No automatic recording trigger. */
export function configurePcLoopback(window: BrowserWindow): void {
  window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    if (process.platform !== 'win32' || !request.userGesture || request.frame !== window.webContents.mainFrame) {
      callback({})
      return
    }
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      if (!sources[0] || window.isDestroyed()) { callback({}); return }
      callback({ video: sources[0], audio: 'loopback' })
    }).catch(() => callback({}))
  })
}

export function registerPcRecorderHandlers(): void {
  quitting = false
  const recorder = new PcRecorder(join(app.getPath('userData'), 'pc-recordings'), async (path) => importExternalRecording(path,
    quitting ? { preserveFilename: true, deferProcessing: true } : { preserveFilename: true }))
  const recovery = recorder.recover().catch((error) => { console.error('[PcRecorder] Startup recovery failed:', error) })
  let owner: number | null = null
  let sessionId: string | null = null
  let finishing: Promise<unknown> | null = null
  let releaseOwner: (() => void) | null = null
  let finishQuit: (() => void) | null = null
  const checkOwner = (sender: number) => {
    if (owner !== sender) throw new Error('Unknown recording owner')
  }
  ipcMain.handle('pc-recorder:start', async (event) => {
    await recovery
    await recorder.recover()
    if (quitting) throw new Error('The application is quitting')
    const id = recorder.start()
    sessionId = id
    owner = event.sender.id
    const abandon = () => { recorder.close(); releaseOwner?.() }
    const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) abandon()
    }
    // A renderer crash abandons only the session, never the durable file.
    event.sender.once('destroyed', abandon)
    event.sender.once('render-process-gone', abandon)
    event.sender.on('did-start-navigation', navigated)
    releaseOwner = () => {
      event.sender.removeListener('destroyed', abandon)
      event.sender.removeListener('render-process-gone', abandon)
      event.sender.removeListener('did-start-navigation', navigated)
      owner = null
      sessionId = null
      requestStop = null
      finishQuit?.()
      finishQuit = null
      releaseOwner = null
    }
    let quitPromise: Promise<void> | null = null
    requestStop = () => quitPromise ??= new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.error('[PcRecorder] Quit flush timed out; synced chunks will be recovered on next start')
        finishQuit = null
        resolve()
      }, 10000)
      finishQuit = () => { clearTimeout(timeout); resolve() }
      try { event.sender.send('pc-recorder:request-stop') }
      catch (error) {
        console.error('[PcRecorder] Renderer unavailable; synced chunks retained:', error)
        finishQuit?.()
      }
    })
    return id
  })
  ipcMain.handle('pc-recorder:append', (event, id: string, index: number, data: Uint8Array) => {
    checkOwner(event.sender.id)
    recorder.append(id, index, data)
  })
  ipcMain.handle('pc-recorder:finish', async (event, id: string) => {
    checkOwner(event.sender.id)
    if (id !== sessionId) throw new Error('Unknown recording session')
    if (finishing) return finishing
    finishing = (async () => {
      try {
        const result = await recorder.finish(id)
        releaseOwner?.()
        return result
      } catch (error) {
        // Disk/import failures keep the file for startup recovery and release quit.
        recorder.close()
        releaseOwner?.()
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      } finally { finishing = null }
    })()
    return finishing
  })
}
