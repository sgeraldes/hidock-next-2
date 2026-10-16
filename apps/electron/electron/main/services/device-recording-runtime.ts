import { app } from 'electron'
import { join } from 'path'
import { existsSync, openSync, fstatSync, readSync, closeSync } from 'fs'
import { DeviceRecordingMarkerService, type MarkerContext, type MarkerSubject } from './device-recording-markers'
import { getRecordingById } from './database'
import { isRecordingEligible } from './recording-eligibility'
import { inspectDeviceAudioWav } from './device-audio-track-export'

let activeCapture: () => { sessionId: string | null; elapsedMs: number; filePath?: string } = () => ({ sessionId: null, elapsedMs: 0 })
export function bindDeviceMarkerCapture(provider: typeof activeCapture): void { activeCapture = provider }

/** Only IDs cross IPC. Filesystem paths are resolved from the existing database/owner. */
export async function resolveDeviceRecording(subject: MarkerSubject): Promise<MarkerContext | undefined> {
  if (subject.kind === 'session') {
    const capture = activeCapture()
    return capture.sessionId === subject.id ? { filePath: capture.filePath, elapsedMs: Math.floor(capture.elapsedMs) } : undefined
  }
  const recording = getRecordingById(subject.id)
  if (!recording || recording.deleted_at || recording.location === 'deleted' || !recording.on_local || !recording.file_path || !existsSync(recording.file_path)) return undefined
  let durationMs = recording.duration_seconds != null && Number.isFinite(recording.duration_seconds) && recording.duration_seconds >= 0
    ? Math.round(recording.duration_seconds * 1000) : undefined
  if (durationMs === undefined && /\.wav$/i.test(recording.file_path)) {
    try { durationMs = (await inspectDeviceAudioWav(recording.file_path)).durationMs }
    catch { /* Unknown duration remains unavailable when the actual PCM container is invalid. */ }
  }
  return {
    filePath: recording.file_path,
    durationMs
  }
}

let instance: DeviceRecordingMarkerService | undefined
export function getDeviceRecordingMarkers(): DeviceRecordingMarkerService {
  return instance ??= new DeviceRecordingMarkerService(join(app.getPath('userData'), 'device-recording-markers'), resolveDeviceRecording, (subject, automatic) => {
    if (subject.kind === 'session') return activeCapture().sessionId === subject.id && !automatic
    const recording = getRecordingById(subject.id)
    return !!recording && !recording.deleted_at && recording.location !== 'deleted' && !!recording.on_local &&
      !!recording.file_path && existsSync(recording.file_path) && (!automatic || isRecordingEligible(subject.id))
  })
}

/** Reuse existing local analysis only; opt-in never starts a provider request. */
export async function applyExistingDeviceMarkerAnalysis(recordingId: string): Promise<void> {
  if (!isRecordingEligible(recordingId)) return
  const { getTimelineAnalysis } = await import('./timeline-analysis')
  const { addAnalysisRecordingMarkers } = await import('./device-recording-markers')
  const subject: MarkerSubject = { kind: 'recording', id: recordingId }
  const service = getDeviceRecordingMarkers()
  if (!(await service.getSettings(subject)).automationEnabled) return
  const analysis = getTimelineAnalysis(recordingId)
  if (!isRecordingEligible(recordingId)) return
  await addAnalysisRecordingMarkers(service, subject, analysis.eventMarkers)
}

/** Associate only after the watcher has assigned the saved WAV its recording ID. */
export async function associateDeviceCaptureMarkers(recordingId: string): Promise<void> {
  const subject: MarkerSubject = { kind: 'recording', id: recordingId }
  const context = await resolveDeviceRecording(subject)
  if (!context?.filePath || !/\.wav$/i.test(context.filePath) || context.durationMs === undefined) return
  const notePath = context.filePath.replace(/\.wav$/i, '.live.json')
  // A damaged capture manifest must not hide the saved recording's own markers.
  // Bound the read on the opened descriptor, including concurrent file growth.
  let descriptor: number | undefined
  let note: { captureSessionId?: unknown }
  try {
    descriptor = openSync(notePath, 'r')
    const size = fstatSync(descriptor).size
    if (size < 2 || size > 256 * 1024) return
    const bytes = Buffer.alloc(size)
    if (readSync(descriptor, bytes, 0, size, 0) !== size) return
    note = JSON.parse(bytes.toString('utf8')) as { captureSessionId?: unknown }
    if (!note || typeof note !== 'object') return
  } catch { return }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
  if (typeof note.captureSessionId !== 'string' || !note.captureSessionId.trim() || note.captureSessionId.length > 512) return
  await getDeviceRecordingMarkers().associateSession({ kind: 'session', id: note.captureSessionId }, subject)
}
