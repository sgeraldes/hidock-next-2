// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const { getRecordingById, paths } = vi.hoisted(() => ({ getRecordingById: vi.fn(), paths: { userData: '' } }))
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }))
vi.mock('../database', () => ({ getRecordingById }))
vi.mock('../recording-eligibility', () => ({ isRecordingEligible: () => true }))
import { associateDeviceCaptureMarkers, bindDeviceMarkerCapture, getDeviceRecordingMarkers, resolveDeviceRecording } from '../device-recording-runtime'
import { wavHeader } from '../realtime-recorder'

let folder: string
let filePath: string
let recordingId: string
let sessionId: string
beforeAll(() => { folder = mkdtempSync(join(tmpdir(), 'hidock-runtime-markers-')); paths.userData = folder })
afterAll(() => { rmSync(folder, { recursive: true, force: true }) })
beforeEach(() => {
  recordingId = randomUUID(); sessionId = randomUUID(); filePath = join(folder, `${recordingId}.wav`)
  getRecordingById.mockReturnValue({ id: recordingId, on_local: 1, file_path: filePath, duration_seconds: null, deleted_at: null, location: 'local' })
  bindDeviceMarkerCapture(() => ({ sessionId, elapsedMs: 2000 }))
})
function savedWav(frames = 16000): Buffer {
  const bytes = Buffer.concat([wavHeader(frames * 4), Buffer.alloc(frames * 4)])
  writeFileSync(filePath, bytes)
  writeFileSync(filePath.replace(/\.wav$/i, '.live.json'), JSON.stringify({ captureSessionId: sessionId, seconds: 999999, sampleElapsedMs: 99999999 }))
  return bytes
}
describe('saved capture marker association with actual WAV duration fallback', () => {
  it('associates and reads back a session marker when the watcher row has unknown duration', async () => {
    const original = savedWav()
    const service = getDeviceRecordingMarkers()
    const marker = await service.add({ subject: { kind: 'session', id: sessionId }, requestId: randomUUID(), atMs: 750, label: 'Captured marker' })
    expect(marker.status).toBe('accepted-local')
    // The capture is no longer active when the watcher has assigned its recording ID.
    bindDeviceMarkerCapture(() => ({ sessionId: null, elapsedMs: 0 }))
    expect(await resolveDeviceRecording({ kind: 'recording', id: recordingId })).toEqual({ filePath, durationMs: 1000 })
    await associateDeviceCaptureMarkers(recordingId)
    await associateDeviceCaptureMarkers(recordingId)
    expect(await service.list({ kind: 'recording', id: recordingId })).toEqual([marker.marker])
    expect(readFileSync(filePath)).toEqual(original)
  })
  it('does not trust manifest timing for markers beyond actual sample duration', async () => {
    savedWav()
    const service = getDeviceRecordingMarkers()
    await service.add({ subject: { kind: 'session', id: sessionId }, requestId: randomUUID(), atMs: 1500 })
    await expect(associateDeviceCaptureMarkers(recordingId)).rejects.toThrow('duration')
    expect(await service.list({ kind: 'recording', id: recordingId })).toEqual([])
  })
  it('refuses invalid WAV duration without associating markers or changing originals', async () => {
    const original = Buffer.from('RIFFinvalid capture')
    writeFileSync(filePath, original)
    writeFileSync(filePath.replace(/\.wav$/i, '.live.json'), JSON.stringify({ captureSessionId: sessionId }))
    const service = getDeviceRecordingMarkers()
    await service.add({ subject: { kind: 'session', id: sessionId }, requestId: randomUUID(), atMs: 250 })
    expect((await resolveDeviceRecording({ kind: 'recording', id: recordingId }))?.durationMs).toBeUndefined()
    await associateDeviceCaptureMarkers(recordingId)
    expect(await service.list({ kind: 'recording', id: recordingId })).toEqual([])
    expect(readFileSync(filePath)).toEqual(original)
  })
  it('preserves known database duration and rejects deleted rows before file inspection', async () => {
    savedWav()
    getRecordingById.mockReturnValue({ id: recordingId, on_local: 1, file_path: filePath, duration_seconds: 3.5, deleted_at: null, location: 'local' })
    expect((await resolveDeviceRecording({ kind: 'recording', id: recordingId }))?.durationMs).toBe(3500)
    getRecordingById.mockReturnValue({ id: recordingId, on_local: 1, file_path: filePath, duration_seconds: null, deleted_at: '2026-10-11', location: 'local' })
    expect(await resolveDeviceRecording({ kind: 'recording', id: recordingId })).toBeUndefined()
  })
})
