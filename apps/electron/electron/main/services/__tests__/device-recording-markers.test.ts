// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DeviceRecordingMarkerService, addAnalysisRecordingMarkers, markerRequestIdForEvent, parseNativeMarkerTail, readNativeMarkerTrailer, type MarkerContext, type MarkerSubject } from '../device-recording-markers'
import { registerDeviceRecordingMarkerHandlers } from '../../ipc/device-recording-marker-handlers'

const recording: MarkerSubject = { kind: 'recording', id: 'rec-1' }
const session: MarkerSubject = { kind: 'session', id: 'live-1' }
function trailer(values: number[]): Buffer {
  const buffer = Buffer.alloc(12 + values.length * 4)
  buffer.write('HiDockVM', 0, 'ascii')
  buffer.writeUInt32LE(values.length, 8)
  values.forEach((value, index) => buffer.writeUInt32LE(value, 12 + index * 4))
  return buffer
}
describe('device recording markers at the real filesystem boundary', () => {
  let directory: string
  let filePath: string
  let service: DeviceRecordingMarkerService
  const contexts = new Map<string, MarkerContext>()
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'hidock-marker-test-'))
    filePath = join(directory, 'input.mp3')
    contexts.set(recording.id, { durationMs: 2_000_000, filePath })
    contexts.set(session.id, { elapsedMs: 12345 })
    service = new DeviceRecordingMarkerService(join(directory, 'sidecars'), async subject => contexts.get(subject.id))
  })
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); contexts.clear() })

  it('parses little-endian native milliseconds including zero, duplicates and uint32 max', () => {
    const bytes = trailer([0, 12345, 12345, 0xffffffff])
    expect(parseNativeMarkerTail(bytes, 1000)).toMatchObject({ present: true, timestampsMs: [0, 12345, 12345, 0xffffffff], audioPrefixBytes: 1000 - bytes.length })
    expect(parseNativeMarkerTail(trailer([]), 12).present).toBe(true)
    expect(parseNativeMarkerTail(Buffer.from('ordinary audio'), 14).present).toBe(false)
  })
  it('rejects truncated, misplaced, over-capacity, and ambiguous signatures', () => {
    expect(() => parseNativeMarkerTail(Buffer.from('HiDockVM'), 8)).toThrow('Truncated')
    expect(() => parseNativeMarkerTail(Buffer.concat([trailer([1]), Buffer.from('extra')]), 21)).toThrow('Malformed')
    expect(() => parseNativeMarkerTail(trailer(Array(101).fill(0)), 416)).toThrow('Invalid native marker tail')
    const malformed = trailer([1]); malformed.writeUInt32LE(101, 8)
    expect(() => parseNativeMarkerTail(malformed, malformed.length)).toThrow('Malformed')
    expect(() => parseNativeMarkerTail(Buffer.concat([trailer([]), trailer([])]), 24)).toThrow('Malformed')
  })
  it('imports a file idempotently, retains milliseconds and never changes original bytes', async () => {
    const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(600), trailer([0, 12345, 12345])])
    await fs.writeFile(filePath, bytes)
    expect(await readNativeMarkerTrailer(filePath)).toMatchObject({ timestampsMs: [0, 12345, 12345] })
    const first = await service.importNative(recording)
    const second = await service.importNative(recording)
    expect(second).toEqual(first)
    expect((await service.list(recording)).map(marker => marker.persistence)).toEqual(['native-file', 'native-file', 'native-file'])
    expect(await fs.readFile(filePath)).toEqual(bytes)
    const reopened = new DeviceRecordingMarkerService(join(directory, 'sidecars'), async subject => contexts.get(subject.id))
    expect(await reopened.list(recording)).toEqual(first.markers)
  })
  it('rejects non-MP3 and out-of-duration imported markers', async () => {
    await fs.writeFile(filePath, Buffer.from('RIFFnot an mp3'))
    await expect(service.importNative(recording)).rejects.toThrow('MP3')
    await fs.writeFile(filePath, Buffer.concat([Buffer.from('ID3'), trailer([2_000_001])]))
    await expect(service.importNative(recording)).rejects.toThrow('duration')
    expect(await service.list(recording)).toEqual([])
  })
  it('serializes concurrent retry requests, persists a local marker and survives restart', async () => {
    const request = { subject: session, requestId: randomUUID(), source: 'shortcut' as const }
    const results = await Promise.all([service.add(request), service.add(request)])
    expect(results.map(result => result.status)).toEqual(['accepted-local', 'duplicate'])
    expect(results[0].marker).toMatchObject({ atMs: 12345, source: 'shortcut', persistence: 'local-sidecar' })
    const reopened = new DeviceRecordingMarkerService(join(directory, 'sidecars'), async subject => contexts.get(subject.id))
    expect(await reopened.add(request)).toMatchObject({ status: 'duplicate', marker: results[0].marker })
  })
  it('validates delayed timestamps and never claims unsupported native writes', async () => {
    for (const atMs of [-1, 12346, NaN, 1.5, 0xffffffff + 1]) expect((await service.add({ subject: session, requestId: randomUUID(), atMs })).status).toBe('invalid')
    expect((await service.add({ subject: session, requestId: randomUUID(), atMs: 2 })).status).toBe('accepted-local')
    expect((await service.add({ subject: session, requestId: randomUUID(), target: 'native' })).status).toBe('unsupported')
    expect(await service.list(session)).toHaveLength(1)
    expect((await service.add({ subject: { kind: 'session', id: 'missing' }, requestId: randomUUID() })).status).toBe('inactive')
  })
  it('defaults automation off, gates spacing and reserves twenty explicit slots', async () => {
    const automatic = (atMs: number) => service.add({ subject: recording, requestId: randomUUID(), atMs, source: 'action' })
    expect((await automatic(1000)).status).toBe('automation-disabled')
    await service.setAutomationEnabled(recording, true)
    expect((await automatic(1000)).status).toBe('accepted-local')
    expect((await automatic(9999)).status).toBe('rate-limited')
    for (let index = 1; index < 80; index++) expect((await automatic(1000 + index * 10000)).status).toBe('accepted-local')
    expect((await automatic(810000)).status).toBe('full')
    for (let index = 0; index < 20; index++) expect((await service.add({ subject: recording, requestId: randomUUID(), atMs: index, source: 'manual' })).status).toBe('accepted-local')
    expect((await service.add({ subject: recording, requestId: randomUUID(), atMs: 0 })).status).toBe('full')
    expect(await service.list(recording)).toHaveLength(100)
  })
  it('refreshed native import preserves local annotations and replaces native snapshot', async () => {
    await service.add({ subject: recording, requestId: randomUUID(), atMs: 1250, label: 'local' })
    await fs.writeFile(filePath, Buffer.concat([Buffer.from('ID3'), trailer([1000])]))
    await service.importNative(recording)
    await fs.writeFile(filePath, Buffer.concat([Buffer.from('ID3'), trailer([2000])]))
    await service.importNative(recording)
    expect((await service.list(recording)).map(marker => marker.atMs)).toEqual([1250, 2000])
    await fs.writeFile(filePath, Buffer.from('ID3no native markers'))
    expect((await service.importNative(recording)).status).toBe('absent')
    expect((await service.list(recording)).map(marker => marker.atMs)).toEqual([1250])
  })
  it('associates session annotations to a saved recording without duplicates or losing source', async () => {
    const result = await service.add({ subject: session, requestId: randomUUID(), atMs: 12000, source: 'shortcut', label: 'follow up' })
    await service.associateSession(session, recording)
    await service.associateSession(session, recording)
    expect(await service.list(recording)).toEqual([result.marker])
    expect(await service.list(session)).toEqual([result.marker])
    expect(await service.getSettings(recording)).toEqual({ automationEnabled: false })
    contexts.set(recording.id, { durationMs: 1 })
    await expect(service.associateSession(session, recording)).rejects.toThrow('duration')
  })
  it('automates existing analytic events idempotently while retaining milliseconds and provenance', async () => {
    const events = [{ id: 'action-1', kind: 'action' as const, atSec: 12.345, label: 'Follow up' }, { id: 'decision-1', kind: 'decision' as const, atSec: 25.123, label: 'Agreed' }]
    expect((await addAnalysisRecordingMarkers(service, recording, events)).map(result => result.status)).toEqual(['automation-disabled', 'automation-disabled'])
    await service.setAutomationEnabled(recording, true)
    expect((await addAnalysisRecordingMarkers(service, recording, events)).map(result => result.status)).toEqual(['accepted-local', 'accepted-local'])
    expect((await addAnalysisRecordingMarkers(service, recording, events)).map(result => result.status)).toEqual(['duplicate', 'duplicate'])
    expect((await service.list(recording)).map(marker => [marker.atMs, marker.source, marker.persistence])).toEqual([[12345, 'action', 'local-sidecar'], [25123, 'decision', 'local-sidecar']])
    expect(markerRequestIdForEvent(recording, 'action-1', 'action')).not.toBe(markerRequestIdForEvent(session, 'action-1', 'action'))
  })
  it('rejects corruption instead of overwriting sidecars, and hides arbitrary paths behind ID-only IPC', async () => {
    await service.add({ subject: recording, requestId: randomUUID(), atMs: 0 })
    const sidecarDirectory = join(directory, 'sidecars')
    const files = await fs.readdir(sidecarDirectory)
    await fs.writeFile(join(sidecarDirectory, files[0]), '{"broken":true}')
    await expect(service.list(recording)).rejects.toThrow('Invalid marker sidecar')
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    registerDeviceRecordingMarkerHandlers(service, (channel, handler) => handlers.set(channel, handler))
    await expect(handlers.get('device-markers:import-native')!(null, { ...recording, filePath })).rejects.toThrow('Invalid marker subject')
    await expect(handlers.get('device-markers:add')!(null, { subject: session, requestId: randomUUID(), filePath })).rejects.toThrow('Invalid marker request')
  })
  it('rejects oversized stored marker metadata without replacing it', async () => {
    await service.add({ subject: recording, requestId: randomUUID(), atMs: 0 })
    const sidecarDirectory = join(directory, 'sidecars')
    const files = await fs.readdir(sidecarDirectory)
    const path = join(sidecarDirectory, files[0])
    const oversized = Buffer.alloc(1024 * 1024 + 1, 32)
    await fs.writeFile(path, oversized)
    await expect(service.list(recording)).rejects.toThrow('Invalid marker sidecar size')
    await expect(service.add({ subject: recording, requestId: randomUUID(), atMs: 1000 })).rejects.toThrow('Invalid marker sidecar size')
    expect(await fs.readFile(path)).toEqual(oversized)
  })
})
