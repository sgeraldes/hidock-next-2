import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { inspectDeviceAudioWav } from './device-audio-track-export'
import type { AddRecordingMarkerRequest, MarkerResult, MarkerSource, MarkerSubject, RecordingMarker } from '../../../src/shared/device-recording-markers'
export type { AddRecordingMarkerRequest, MarkerResult, MarkerSource, MarkerSubject, RecordingMarker } from '../../../src/shared/device-recording-markers'
export interface MarkerContext {
  /** Main-process resolved path only; never accepted from a renderer request. */
  filePath?: string
  durationMs?: number
  /** The existing recording owner supplies elapsed time for active sessions. */
  elapsedMs?: number
}
interface MarkerState { version: 1; subject: MarkerSubject; automationEnabled: boolean; markers: RecordingMarker[]; associatedSessionId?: string }
export interface NativeMarkerTrailer { present: boolean; timestampsMs: number[]; audioPrefixBytes: number; trailerSha256?: string }
const SIGNATURE = Buffer.from('HiDockVM', 'ascii')
const CAPACITY = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCES: MarkerSource[] = ['manual', 'shortcut', 'action', 'decision', 'audio-event', 'native-file']
const isAutomatic = (source: MarkerSource): boolean => ['action', 'decision', 'audio-event'].includes(source)
const isUint32 = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
const subjectKey = (subject: MarkerSubject): string => createHash('sha256').update(`${subject.kind}\0${subject.id}`).digest('hex')
function validateSubject(subject: MarkerSubject): void {
  if (!subject || !['recording', 'session'].includes(subject.kind) || typeof subject.id !== 'string' || !subject.id.trim() || subject.id.length > 512) {
    throw new Error('Invalid marker subject')
  }
}

/** Deterministic UUID for a stable analysis/audio event identity; use the same ID on re-analysis. */
export function markerRequestIdForEvent(subject: MarkerSubject, eventId: string, source: 'action' | 'decision' | 'audio-event'): string {
  validateSubject(subject)
  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 512) throw new Error('Invalid marker event identity')
  const bytes = createHash('sha256').update(`hidock-markers-v1\0${subjectKey(subject)}\0${source}\0${eventId}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80 // UUIDv8, application-defined stable event hash.
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Consumes existing analysis outputs without changing their analytic meaning. Opt-in policy is enforced by add(). */
export async function addAnalysisRecordingMarkers(
  service: DeviceRecordingMarkerService,
  subject: MarkerSubject,
  events: Array<{ id: string; kind: 'action' | 'decision'; atSec: number; label: string }>
): Promise<MarkerResult[]> {
  const results: MarkerResult[] = []
  for (const event of [...events].sort((a, b) => a.atSec - b.atSec)) {
    results.push(await service.add({ subject, requestId: markerRequestIdForEvent(subject, event.id, event.kind), atMs: Math.round(event.atSec * 1000), label: event.label, source: event.kind }))
  }
  return results
}

/** Parse only a bounded file tail; neither decoder bytes nor original files are modified. */
export function parseNativeMarkerTail(tail: Buffer, fileBytes: number): NativeMarkerTrailer {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < tail.length || tail.length > 412) throw new Error('Invalid native marker tail')
  let result: NativeMarkerTrailer | undefined
  for (let offset = 0; offset + SIGNATURE.length <= tail.length; offset++) {
    if (!tail.subarray(offset, offset + 8).equals(SIGNATURE)) continue
    if (offset + 12 > tail.length) throw new Error('Truncated HiDockVM trailer')
    const count = tail.readUInt32LE(offset + 8)
    if (count > CAPACITY || offset + 12 + count * 4 !== tail.length || result) throw new Error('Malformed or ambiguous HiDockVM trailer')
    result = {
      present: true,
      timestampsMs: Array.from({ length: count }, (_, index) => tail.readUInt32LE(offset + 12 + index * 4)),
      audioPrefixBytes: fileBytes - tail.length + offset,
      trailerSha256: createHash('sha256').update(tail.subarray(offset)).digest('hex')
    }
  }
  return result ?? { present: false, timestampsMs: [], audioPrefixBytes: fileBytes }
}

export async function readNativeMarkerTrailer(filePath: string): Promise<NativeMarkerTrailer> {
  const handle = await fs.open(filePath, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Expected a recording file')
    const head = Buffer.alloc(12)
    const header = await handle.read(head, 0, head.length, 0)
    const isWav = header.bytesRead === 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE'
    const isMp3 = header.bytesRead >= 2 && (head.toString('ascii', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))
    if (!isWav && !isMp3) throw new Error('Native markers require an MP3 or valid PCM16 WAV file')
    if (isWav) await inspectDeviceAudioWav(filePath)
    const tail = Buffer.alloc(Math.min(before.size, 412))
    const read = await handle.read(tail, 0, tail.length, before.size - tail.length)
    const after = await handle.stat()
    if (read.bytesRead !== tail.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Recording changed while reading markers')
    const result = parseNativeMarkerTail(tail, before.size)
    if (isWav && result.present && result.audioPrefixBytes !== head.readUInt32LE(4) + 8) throw new Error('Native WAV markers must follow the complete RIFF payload')
    return result
  } finally { await handle.close() }
}

/** Local annotations are durable sidecars. No native device insertion command is inferred. */
export class DeviceRecordingMarkerService {
  private pending = new Map<string, Promise<unknown>>()
  constructor(
    private readonly directory: string,
    private readonly resolveSubject: (subject: MarkerSubject) => Promise<MarkerContext | undefined>,
    private readonly canPublish: (subject: MarkerSubject, automatic: boolean) => boolean = () => true
  ) {}

  private async serialize<T>(subject: MarkerSubject, task: () => Promise<T>): Promise<T> {
    validateSubject(subject)
    const key = subjectKey(subject)
    const previous = this.pending.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(task)
    this.pending.set(key, operation)
    try { return await operation } finally { if (this.pending.get(key) === operation) this.pending.delete(key) }
  }

  private async read(subject: MarkerSubject): Promise<MarkerState> {
    let raw: string
    try {
      const file = await fs.open(join(this.directory, `${subjectKey(subject)}.json`), 'r')
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size < 2 || info.size > 1024 * 1024) throw new Error('Invalid marker sidecar size')
        const buffer = Buffer.alloc(info.size)
        let offset = 0
        while (offset < buffer.length) {
          const result = await file.read(buffer, offset, buffer.length - offset, offset)
          if (!result.bytesRead) throw new Error('Truncated marker sidecar')
          offset += result.bytesRead
        }
        raw = buffer.toString('utf8')
      } finally { await file.close() }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, subject, automationEnabled: false, markers: [] }
      throw error
    }
    const state = JSON.parse(raw) as MarkerState
    if (state.version !== 1 || state.subject?.id !== subject.id || state.subject?.kind !== subject.kind || typeof state.automationEnabled !== 'boolean' || !Array.isArray(state.markers) || state.markers.length > 200) throw new Error('Invalid marker sidecar')
    for (const marker of state.markers) {
      if (typeof marker.id !== 'string' || !isUint32(marker.atMs) || !SOURCES.includes(marker.source) || !['local-sidecar', 'native-file'].includes(marker.persistence) || typeof marker.createdAt !== 'string') throw new Error('Invalid marker in sidecar')
    }
    return state
  }

  private async write(state: MarkerState, automatic = false): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, `${subjectKey(state.subject)}.json`)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, 'wx')
      try { await handle.writeFile(JSON.stringify(state, null, 2), 'utf8'); await handle.sync() } finally { await handle.close() }
      if (!this.canPublish(state.subject, automatic)) throw new Error('Recording became unavailable or excluded before marker publication')
      await fs.rename(temporary, destination)
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async list(subject: MarkerSubject): Promise<RecordingMarker[]> {
    return this.serialize(subject, async () => {
      if (!await this.resolveSubject(subject)) throw new Error('Recording or session unavailable')
      return (await this.read(subject)).markers.sort((a, b) => a.atMs - b.atMs)
    })
  }

  async setAutomationEnabled(subject: MarkerSubject, enabled: boolean): Promise<void> {
    return this.serialize(subject, async () => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid automation setting')
      if (!await this.resolveSubject(subject)) throw new Error('Recording or session unavailable')
      const state = await this.read(subject)
      state.automationEnabled = enabled
      await this.write(state)
    })
  }

  async getSettings(subject: MarkerSubject): Promise<{ automationEnabled: boolean }> {
    return this.serialize(subject, async () => {
      if (!await this.resolveSubject(subject)) throw new Error('Recording or session unavailable')
      return { automationEnabled: (await this.read(subject)).automationEnabled }
    })
  }

  /** Call from the trusted capture owner after its saved recording is available. */
  async associateSession(session: MarkerSubject, recording: MarkerSubject): Promise<void> {
    if (session.kind !== 'session' || recording.kind !== 'recording') throw new Error('Expected session and recording subjects')
    await this.serialize(session, async () => this.serialize(recording, async () => {
      const context = await this.resolveSubject(recording)
      if (!context || !Number.isFinite(context.durationMs)) throw new Error('Saved recording duration unavailable')
      const source = await this.read(session)
      const destination = await this.read(recording)
      const annotations = source.markers.filter(marker => marker.persistence === 'local-sidecar')
      if (annotations.some(marker => marker.atMs > context.durationMs!)) throw new Error('Session annotation exceeds saved recording duration')
      if (destination.associatedSessionId === session.id && annotations.every(marker => destination.markers.some(existing => existing.id === marker.id || (marker.requestId && existing.requestId === marker.requestId)))) return
      for (const marker of annotations) if (!destination.markers.some(existing => existing.id === marker.id || (marker.requestId && existing.requestId === marker.requestId))) destination.markers.push(marker)
      // Only transfer opt-in on the first association; a later explicit change wins.
      if (!destination.associatedSessionId) destination.automationEnabled = source.automationEnabled
      destination.associatedSessionId = session.id
      if (destination.markers.length > 200) throw new Error('Combined marker sidecar capacity exceeded')
      await this.write(destination)
      // Preserve the session sidecar as a recovery source; repeated association is idempotent.
    }))
  }

  async add(request: AddRecordingMarkerRequest): Promise<MarkerResult> {
    return this.serialize(request.subject, async () => {
      if (typeof request.requestId !== 'string' || !UUID.test(request.requestId) || (request.target !== undefined && !['local', 'native'].includes(request.target)) || (request.source !== undefined && (!SOURCES.includes(request.source) || request.source === ('native-file' as MarkerSource)))) return { status: 'invalid', reason: 'Invalid marker request' }
      if (request.target === 'native') return { status: 'unsupported', reason: 'No vetted native insertion command is available; no device write occurred' }
      const context = await this.resolveSubject(request.subject)
      if (!context) return { status: 'inactive' }
      const state = await this.read(request.subject)
      const duplicate = state.markers.find(marker => marker.requestId === request.requestId)
      if (duplicate) return { status: 'duplicate', marker: duplicate }
      const source = request.source ?? 'manual'
      const upperBound = request.subject.kind === 'session' ? context.elapsedMs : context.durationMs
      const atMs = request.atMs ?? (request.subject.kind === 'session' ? context.elapsedMs : undefined)
      if (!isUint32(atMs) || !Number.isFinite(upperBound) || Number(upperBound) < 0 || atMs > Number(upperBound)) return { status: 'invalid', reason: 'Timestamp must be within known recording duration or active elapsed time' }
      if (request.label !== undefined && (typeof request.label !== 'string' || request.label.length > 512)) return { status: 'invalid', reason: 'Label exceeds 512 characters' }
      if (isAutomatic(source)) {
        if (!state.automationEnabled) return { status: 'automation-disabled' }
        if (state.markers.filter(marker => isAutomatic(marker.source)).length >= 80) return { status: 'full', reason: 'Automatic marker capacity is 80' }
        if (state.markers.some(marker => isAutomatic(marker.source) && Math.abs(marker.atMs - atMs) < 10000)) return { status: 'rate-limited' }
      }
      if (state.markers.length >= CAPACITY) return { status: 'full', reason: 'Marker capacity is 100' }
      const marker: RecordingMarker = { id: randomUUID(), requestId: request.requestId, atMs, source, persistence: 'local-sidecar', createdAt: new Date().toISOString(), ...(request.label?.trim() ? { label: request.label.trim() } : {}) }
      state.markers.push(marker)
      await this.write(state, isAutomatic(source))
      return { status: 'accepted-local', marker }
    })
  }

  async importNative(subject: MarkerSubject): Promise<{ status: 'imported' | 'absent' | 'unsupported'; markers: RecordingMarker[] }> {
    return this.serialize(subject, async () => {
      const context = await this.resolveSubject(subject)
      if (!context) throw new Error('Recording or session unavailable')
      if (subject.kind !== 'recording' || !context.filePath) return { status: 'unsupported', markers: [] }
      const trailer = await readNativeMarkerTrailer(context.filePath)
      if (!trailer.present) {
        const state = await this.read(subject)
        if (state.markers.some(marker => marker.persistence === 'native-file')) {
          state.markers = state.markers.filter(marker => marker.persistence !== 'native-file')
          await this.write(state)
        }
        return { status: 'absent', markers: [] }
      }
      if (context.durationMs !== undefined && trailer.timestampsMs.some(atMs => atMs > context.durationMs!)) throw new Error('Native marker exceeds recording duration')
      const state = await this.read(subject)
      const createdAt = new Date().toISOString()
      const markers = trailer.timestampsMs.map((atMs, index): RecordingMarker => {
        const id = `native-${createHash('sha256').update(`${subjectKey(subject)}:${index}:${atMs}`).digest('hex')}`
        return { id, atMs, source: 'native-file', persistence: 'native-file', createdAt: state.markers.find(marker => marker.id === id)?.createdAt ?? createdAt, native: { format: 'HiDockVM', trailerSha256: trailer.trailerSha256!, index } }
      })
      // A refreshed file replaces its imported trailer snapshot; local annotations survive.
      state.markers = [...state.markers.filter(marker => marker.persistence !== 'native-file'), ...markers]
      await this.write(state)
      return { status: 'imported', markers }
    })
  }
}
