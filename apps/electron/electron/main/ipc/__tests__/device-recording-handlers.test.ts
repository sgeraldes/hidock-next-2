// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const state = vi.hoisted(() => ({ root: '', rows: new Map<string, any>(), eligible: true, handlers: new Map<string, (...args: any[]) => Promise<any>>() }))
vi.mock('electron', () => ({ app: { getPath: () => state.root }, ipcMain: { handle: (name: string, fn: (...args: any[]) => Promise<any>) => state.handlers.set(name, fn) } }))
vi.mock('../../services/database', () => ({ getRecordingById: (id: string) => state.rows.get(id) }))
vi.mock('../../services/recording-eligibility', () => ({ isRecordingEligible: () => state.eligible }))
vi.mock('../../services/timeline-analysis', () => ({ getTimelineAnalysis: () => ({ eventMarkers: [{ id: 'action-1', kind: 'action', atSec: 1, label: 'Existing action' }] }) }))

function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 16)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(64000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(16, 40)
  ;[100, -200, 300, -400, 500, -600, 700, -800].forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2))
  return bytes
}
const invoke = (name: string, ...args: unknown[]) => state.handlers.get(name)!({}, ...args)

describe('device audio IPC and durable annotation integration', () => {
  beforeEach(async () => {
    vi.resetModules()
    state.root = await fs.mkdtemp(join(tmpdir(), 'hidock-device-ipc-'))
    state.rows.clear(); state.handlers.clear(); state.eligible = true
    const filePath = join(state.root, 'capture.wav')
    await fs.writeFile(filePath, wav())
    state.rows.set('recording-1', { id: 'recording-1', file_path: filePath, on_local: 1, duration_seconds: 30, location: 'local', deleted_at: null })
    const { registerDeviceRecordingHandlers } = await import('../device-recording-handlers')
    registerDeviceRecordingHandlers()
  })
  afterEach(async () => { await fs.rm(state.root, { recursive: true, force: true }) })

  it('exports exact synchronized samples through an ID and preserves the source', async () => {
    const result = await invoke('device-audio:export-tracks', 'recording-1')
    expect(result).toMatchObject({ sampleRate: 16000, frames: 4, physicalSourceMapping: 'unverified' })
    for (let channel = 0; channel < 2; channel++) {
      const bytes = await fs.readFile(result.tracks[channel].path)
      expect(bytes.subarray(44)).toEqual(Buffer.from(channel === 0 ? [100, 0, 44, 1, 244, 1, 188, 2] : [56, 255, 112, 254, 168, 253, 224, 252]))
      expect(result.tracks[channel].path.startsWith(join(state.root, 'device-audio-exports'))).toBe(true)
    }
    expect(await fs.readFile(state.rows.get('recording-1').file_path)).toEqual(wav())
    await expect(invoke('device-audio:export-tracks', state.rows.get('recording-1').file_path)).rejects.toThrow('local PCM WAV')
    await expect(invoke('device-audio:export-tracks', { filePath: 'arbitrary.wav' })).rejects.toThrow('Invalid recording ID')
  })

  it('associates session annotations once without undoing a later automation choice', async () => {
    const runtime = await import('../../services/device-recording-runtime')
    runtime.bindDeviceMarkerCapture(() => ({ sessionId: 'session-1', elapsedMs: 2000 }))
    const session = { kind: 'session', id: 'session-1' }
    const subject = { kind: 'recording', id: 'recording-1' }
    await invoke('device-markers:add', { subject: session, requestId: randomUUID(), atMs: 1000 })
    await invoke('device-markers:set-automation', session, true)
    await fs.writeFile(join(state.root, 'capture.live.json'), JSON.stringify({ captureSessionId: 'session-1' }))
    expect(await invoke('device-markers:list', subject)).toHaveLength(1)
    expect(await invoke('device-markers:get-settings', subject)).toEqual({ automationEnabled: true })
    await invoke('device-markers:set-automation', subject, false)
    expect(await invoke('device-markers:get-settings', subject)).toEqual({ automationEnabled: false })
  })

  it('reuses cached analysis after opt-in and refuses automatic publication for exclusions', async () => {
    const subject = { kind: 'recording', id: 'recording-1' }
    expect(await invoke('device-markers:list', subject)).toEqual([])
    await invoke('device-markers:set-automation', subject, true)
    expect(await invoke('device-markers:list', subject)).toMatchObject([{ source: 'action', atMs: 1000, persistence: 'local-sidecar' }])
    await invoke('device-markers:set-automation', subject, true)
    expect(await invoke('device-markers:list', subject)).toHaveLength(1)
    state.eligible = false
    await expect(invoke('device-markers:add', { subject, requestId: randomUUID(), source: 'decision', atMs: 15000 })).rejects.toThrow('excluded')
    expect(await invoke('device-markers:add', { subject, requestId: randomUUID(), source: 'manual', atMs: 15000 })).toMatchObject({ status: 'accepted-local' })
    state.rows.get('recording-1').deleted_at = 'now'
    await expect(invoke('device-markers:list', subject)).rejects.toThrow('unavailable')
  })

  it('keeps saved markers accessible when capture association metadata is damaged or oversized', async () => {
    const subject = { kind: 'recording', id: 'recording-1' }
    await invoke('device-markers:add', { subject, requestId: randomUUID(), atMs: 500, label: 'Saved marker' })
    const notePath = join(state.root, 'capture.live.json')
    for (const payload of ['{broken', 'null', JSON.stringify({ captureSessionId: ' ' }), ' '.repeat(256 * 1024 + 1)]) {
      await fs.writeFile(notePath, payload)
      expect(await invoke('device-markers:list', subject)).toMatchObject([{ label: 'Saved marker', atMs: 500 }])
    }
  })
})
