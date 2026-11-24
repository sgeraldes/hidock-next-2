import { app, ipcMain } from 'electron'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { registerDeviceRecordingMarkerHandlers } from './device-recording-marker-handlers'
import { associateDeviceCaptureMarkers, applyExistingDeviceMarkerAnalysis, getDeviceRecordingMarkers, resolveDeviceRecording } from '../services/device-recording-runtime'
import { exportDeviceAudioTracks } from '../services/device-audio-track-export'

export function registerDeviceRecordingHandlers(): void {
  registerDeviceRecordingMarkerHandlers(getDeviceRecordingMarkers(), (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      const value = args[0] as { kind?: unknown; id?: unknown } | undefined
      if (value?.kind === 'recording' && typeof value.id === 'string' && value.id.trim() && value.id.length <= 512) await associateDeviceCaptureMarkers(value.id)
      const result = await handler(event, ...args)
      if (channel === 'device-markers:set-automation' && args[1] === true && value?.kind === 'recording' && typeof value.id === 'string') {
        await applyExistingDeviceMarkerAnalysis(value.id)
      }
      return result
    })
  })
  ipcMain.handle('device-audio:export-tracks', async (_event, recordingId: unknown) => {
    if (typeof recordingId !== 'string' || !recordingId.trim() || recordingId.length > 512) throw new Error('Invalid recording ID')
    const context = await resolveDeviceRecording({ kind: 'recording', id: recordingId })
    if (!context?.filePath || !/\.wav$/i.test(context.filePath)) throw new Error('A local PCM WAV recording is required')
    const { mkdir } = await import('fs/promises')
    const root = join(app.getPath('userData'), 'device-audio-exports')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'tracks-'))
    try { return await exportDeviceAudioTracks(context.filePath, directory) }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  })
}
