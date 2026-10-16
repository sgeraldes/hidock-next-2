import { DeviceRecordingMarkerService, type AddRecordingMarkerRequest, type MarkerSubject } from '../services/device-recording-markers'

function subjectFrom(value: unknown): MarkerSubject {
  const subject = value as MarkerSubject
  if (!subject || typeof subject !== 'object' || !['recording', 'session'].includes(subject.kind) || typeof subject.id !== 'string' || !subject.id.trim() || subject.id.length > 512 || Object.keys(subject).some(key => !['kind', 'id'].includes(key))) throw new Error('Invalid marker subject')
  return { kind: subject.kind, id: subject.id }
}

/** Registrar is injected so the main app owns IPC lifecycle and trusted sender checks. */
export function registerDeviceRecordingMarkerHandlers(
  service: DeviceRecordingMarkerService,
  register: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => void
): void {
  register('device-markers:list', async (_event, subject) => service.list(subjectFrom(subject)))
  register('device-markers:import-native', async (_event, subject) => service.importNative(subjectFrom(subject)))
  register('device-markers:get-settings', async (_event, subject) => service.getSettings(subjectFrom(subject)))
  register('device-markers:set-automation', async (_event, subject, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid automation setting')
    await service.setAutomationEnabled(subjectFrom(subject), enabled)
    return { enabled }
  })
  register('device-markers:add', async (_event, value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid marker request')
    const request = value as AddRecordingMarkerRequest
    if (Object.keys(request).some(key => !['subject', 'requestId', 'atMs', 'label', 'source', 'target'].includes(key)) || typeof request.requestId !== 'string') throw new Error('Invalid marker request')
    return service.add({ subject: subjectFrom(request.subject), requestId: request.requestId, atMs: request.atMs, label: request.label, source: request.source, target: request.target })
  })
}
