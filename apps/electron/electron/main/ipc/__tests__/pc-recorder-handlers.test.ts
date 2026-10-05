/** @vitest-environment node */
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { app, desktopCapturer, ipcMain, type BrowserWindow } from 'electron'
import { configurePcLoopback, registerPcRecorderHandlers, stopPcRecorderBeforeQuit } from '../pc-recorder-handlers'
import { importExternalRecording } from '../../services/external-recording-import'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { handle: vi.fn() }, desktopCapturer: { getSources: vi.fn() } }))
vi.mock('../../services/external-recording-import', () => ({ importExternalRecording: vi.fn(() => ({ success: true })) }))
let folder: string
beforeEach(() => {
  vi.clearAllMocks()
  folder = mkdtempSync(join(tmpdir(), 'pc-ipc-test-'))
  vi.mocked(app.getPath).mockReturnValue(folder)
})
afterEach(() => rmSync(folder, { recursive: true }))
function handlers() {
  registerPcRecorderHandlers()
  return Object.fromEntries(vi.mocked(ipcMain.handle).mock.calls) as Record<string, (...args: unknown[]) => unknown>
}
describe('PC recorder IPC', () => {
  it('stops through the shared import path and rejects another renderer', async () => {
    const ipc = handlers()
    const sender = Object.assign(new EventEmitter(), { id: 1 })
    const id = await ipc['pc-recorder:start']({ sender })
    expect(() => ipc['pc-recorder:append']({ sender: { id: 2 } }, id, 0, new Uint8Array([1]))).toThrow(/owner/)
    ipc['pc-recorder:append']({ sender }, id, 0, new Uint8Array([1, 2]))
    expect(await ipc['pc-recorder:finish']({ sender }, id)).toMatchObject({ success: true })
    expect(importExternalRecording).toHaveBeenCalledWith(expect.stringMatching(/Recording .*\.webm$/), { preserveFilename: true })
  })
  it('abandons a crashed renderer and imports its partial on the next startup', async () => {
    const ipc = handlers()
    const sender = Object.assign(new EventEmitter(), { id: 1 })
    const id = await ipc['pc-recorder:start']({ sender })
    ipc['pc-recorder:append']({ sender }, id, 0, new Uint8Array([1, 2]))
    sender.emit('render-process-gone')
    registerPcRecorderHandlers()
    await vi.waitFor(() => expect(importExternalRecording).toHaveBeenCalledOnce())
  })
  it('uses Windows loopback only for a user gesture in the main frame', async () => {
    const setHandler = vi.fn()
    const frame = {}
    const window = { webContents: { session: { setDisplayMediaRequestHandler: setHandler }, mainFrame: frame }, isDestroyed: () => false }
    configurePcLoopback(window as unknown as BrowserWindow)
    const callback = vi.fn()
    const handler = setHandler.mock.calls[0][0]
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ id: 'screen' }] as never)
    handler({ frame, userGesture: true }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(callback).toHaveBeenCalledWith(process.platform === 'win32' ? { video: { id: 'screen' }, audio: 'loopback' } : {})
    callback.mockClear()
    handler({ frame: {}, userGesture: true }, callback)
    expect(callback).toHaveBeenCalledWith({})
    callback.mockClear()
    handler({ frame, userGesture: false }, callback)
    expect(callback).toHaveBeenCalledWith({})
  })
  it('asks the renderer to flush and holds quit until the file is imported', async () => {
    const ipc = handlers()
    const sender = Object.assign(new EventEmitter(), { id: 1, send: vi.fn() })
    const id = await ipc['pc-recorder:start']({ sender })
    ipc['pc-recorder:append']({ sender }, id, 0, new Uint8Array([1]))
    const quitting = stopPcRecorderBeforeQuit()
    expect(sender.send).toHaveBeenCalledWith('pc-recorder:request-stop')
    await ipc['pc-recorder:finish']({ sender }, id)
    await quitting
    expect(importExternalRecording).toHaveBeenCalledOnce()
  })
  it('returns no source when desktop capture fails', async () => {
    const setHandler = vi.fn(), frame = {}, callback = vi.fn()
    configurePcLoopback({ webContents: { session: { setDisplayMediaRequestHandler: setHandler }, mainFrame: frame }, isDestroyed: () => false } as unknown as BrowserWindow)
    vi.mocked(desktopCapturer.getSources).mockRejectedValue(new Error('unavailable'))
    setHandler.mock.calls[0][0]({ frame, userGesture: true }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}))
  })
})
