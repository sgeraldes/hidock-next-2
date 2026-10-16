// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CMD, JensenDevice } from '../src/index.js'
const native = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/command-contract630-lab/native/wire-fixtures.json', import.meta.url)), 'utf8'))
const custom = JSON.parse(readFileSync(fileURLToPath(new URL('../../../research/rea/commands630-lab/custom-control/control-execution.json', import.meta.url)), 'utf8'))
const raw = (id: string) => Buffer.from(native.cases.find((row: { id: string }) => row.id === id).response_payloads_hex[0], 'hex')
const control = (name: string) => Buffer.from(custom.cases[name].packets[0], 'hex').subarray(12)
const fixtures: Record<number, Uint8Array> = { 1: raw('cmd1-info'), 16: raw('cmd16-card'), 18: raw('cmd18-inactive'), 29: new Uint8Array(),
  0xf111: control('profile_get_0'), 0xf114: control('get_valid_f114'), 0xf116: control('get_missing_f116') }
function frame(command: number, sequence: number, body: Uint8Array) {
  const bytes = new Uint8Array(12 + body.length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x1234); view.setUint16(2, command); view.setUint32(4, sequence); view.setUint32(8, body.length); bytes.set(body, 12)
  return bytes
}
type Override = (command: number, sequence: number, body: Uint8Array) => Uint8Array | null
function setup(override?: Override) {
  const device = new JensenDevice({ getDevices: async () => [], requestDevice: async () => { throw new Error('Offline only') }, addEventListener() {}, removeEventListener() {} } as unknown as USB)
  const internals = device as unknown as { device: USBDevice; readLoopRunning: boolean; receiveChunks: DataView[]; processBufferedData(): void; firmwareUploadFence: 'none' | 'uploaded' | 'uncertain' }
  const commands: number[] = []
  const transferOut = vi.fn(async (_endpoint: number, request: Uint8Array) => {
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength), command = view.getUint16(2), sequence = view.getUint32(4)
    commands.push(command)
    let body = fixtures[command] ? Uint8Array.from(fixtures[command]) : Uint8Array.of(0)
    if (command === 1) body[3] = 1 // Synthesized target identity; not a native image attestation.
    body = override ? override(command, sequence, body)! : body
    if (body) {
      const bytes = frame(command, sequence, body)
      internals.receiveChunks.push(new DataView(bytes.buffer)); internals.processBufferedData()
    }
    return { status: 'ok', bytesWritten: request.length }
  })
  internals.device = { opened: true, transferOut, reset: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as USBDevice
  internals.readLoopRunning = true
  internals.firmwareUploadFence = 'uploaded'
  device.firmwareRecoveryReadOnly = true
  device.model = 'hidock-h1e'; device.versionNumber = 393984; device.versionCode = '6.3.0'; device.serialNumber = 'LAB630SER0001'
  return { device, internals, commands, transferOut }
}
const expected = { serialNumber: 'LAB630SER0001', versionNumber: 393985, customRecording: true, sourceVersionNumber: 393984 }
afterEach(() => { vi.useRealTimers() })

describe('post-boot operational verification on the actual serialized host command path', () => {
  it.each([393986, 393988])('qualifies custom%s with every extension and keeps durable read-only policy', async version => {
    const state = setup((command, _sequence, body) => { if (command === 1) body[3] = version - 393984; return body })
    expect(await state.device.verifyFirmwareUpdateBoot({ ...expected, versionNumber: version })).toMatchObject({ status: 'confirmed', imageAttested: false,
      deviceInfo: { versionNumber: version, versionCode: `6.3.${version - 393984}` } })
    expect(state.commands).toEqual([1, 0xf111, 0xf114, 0xf116, 29, 18, 16])
    expect(state.device.firmwareRecoveryReadOnly).toBe(true); expect(state.device.getFirmwareUploadFence()).toBe('none')
  })
  it.each([393987, 393989])('qualifies forward%s through native readbacks but rejects labeling it custom before any OUT', async version => {
    const rejected = setup()
    expect(await rejected.device.verifyFirmwareUpdateBoot({ ...expected, versionNumber: version })).toMatchObject({ status: 'unavailable', reason: 'invalid-expectation' })
    expect(rejected.commands).toEqual([])
    const state = setup((command, _sequence, body) => { if (command === 1) body[3] = version - 393984; return body })
    expect(await state.device.verifyFirmwareUpdateBoot({ ...expected, versionNumber: version, sourceVersionNumber: version - 1, customRecording: false })).toMatchObject({ status: 'confirmed', imageAttested: false })
    expect(state.commands).toEqual([1, 29, 18, 16])
  })
  it('runs only exclusive read commands and retains durable read-only guard after confirmation', async () => {
    const state = setup()
    const checking = state.device.verifyFirmwareUpdateBoot(expected)
    const concurrentMutation = state.device.setTime(new Date())
    expect(await checking).toMatchObject({ status: 'confirmed', imageAttested: false, activeRecording: false,
      deviceInfo: { serialNumber: expected.serialNumber, versionNumber: expected.versionNumber }, recordingFormat: { format: 'wav' } })
    expect(await concurrentMutation).toBeNull()
    expect(state.commands).toEqual([1, 0xf111, 0xf114, 0xf116, 29, 18, 16])
    expect(state.device.getFirmwareUploadFence()).toBe('none')
    expect(state.device.firmwareRecoveryReadOnly).toBe(true)
  })
  it('blocks reset and upload after restart even when volatile upload fence is absent', async () => {
    const state = setup(); state.internals.firmwareUploadFence = 'none'
    expect(await state.device.reset()).toBe(false)
    expect(await state.device.uploadFirmware(undefined as never, undefined as never)).toMatchObject({ status: 'rejected', reason: 'firmware-recovery-read-only' })
    expect(await state.device.setAutoRecord(true)).toBeNull()
    expect(state.commands).toEqual([])
  })
  it.each(['none', 'uncertain', 'uploaded'] as const)('closes stalled fallback IN on recovery disconnect without implicit reset when fence is%s', async fence => {
    vi.useFakeTimers()
    const state = setup(); state.internals.firmwareUploadFence = fence
    const handle = state.internals.device
    handle.transferIn = vi.fn(() => new Promise<USBInTransferResult>(() => {}))
    state.internals.readLoopRunning = false
    ;(state.device as unknown as { startReadLoop(): void }).startReadLoop()
    expect(handle.transferIn).toHaveBeenCalledOnce()
    const closing = state.device.disconnect()
    await vi.advanceTimersByTimeAsync(1000)
    await closing
    expect(handle.reset).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
    expect(state.device.isConnected()).toBe(false)
    expect(state.device.firmwareRecoveryReadOnly).toBe(true)
    expect(state.device.getFirmwareUploadFence()).toBe(fence)
  })
  it.each(['uncertain', 'uploaded'] as const)('internal bounded teardown cannot implicitly reset solely guarded%s update', async fence => {
    vi.useFakeTimers()
    const state = setup(); state.internals.firmwareUploadFence = fence; state.device.firmwareRecoveryReadOnly = false
    const handle = state.internals.device
    handle.transferIn = vi.fn(() => new Promise<USBInTransferResult>(() => {}))
    state.internals.readLoopRunning = false
    ;(state.device as unknown as { startReadLoop(): void }).startReadLoop()
    const closing = (state.device as unknown as { performTeardown(): Promise<void> }).performTeardown()
    await vi.advanceTimersByTimeAsync(1000)
    await closing
    expect(handle.reset).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
    expect(state.device.getFirmwareUploadFence()).toBe(fence)
  })
  it.each(['serial', 'version', 'profile', 'format', 'rules', 'status', 'idle', 'card'])('leaves uploaded fence intact on%s mismatch/unavailability', async field => {
    const commands = { serial: 1, version: 1, profile: 0xf111, format: 0xf114, rules: 0xf116, status: 29, idle: 18, card: 16 }
    const state = setup((command, _sequence, body) => {
      if (command !== commands[field as keyof typeof commands]) return body
      if (field === 'serial') { body[4] = 88; return body }
      if (field === 'version') { body[3] = 0; return body }
      return Uint8Array.of(0)
    })
    const reasons = { serial: 'serial-mismatch', version: 'source-version-observed', profile: 'recording-profile-unavailable',
      format: 'recording-format-unavailable', rules: 'marker-rules-unavailable', status: 'recording-status-unavailable',
      idle: 'recording-idle-unavailable', card: 'card-unavailable' }
    expect(await state.device.verifyFirmwareUpdateBoot(expected)).toMatchObject({ reason: reasons[field as keyof typeof reasons] })
    expect(state.device.getFirmwareUploadFence()).toBe('uploaded')
    expect(state.device.firmwareRecoveryReadOnly).toBe(true)
  })
  it('rejects source-equal target without dispatch, including durable restart metadata', async () => {
    const state = setup()
    expect(await state.device.verifyFirmwareUpdateBoot({ ...expected, sourceVersionNumber: expected.versionNumber })).toMatchObject({ status: 'mismatch', reason: 'target-version-equals-source' })
    expect(state.commands).toEqual([])
  })
  it('requires durable source version when volatile upload context was lost on restart', async () => {
    const state = setup()
    expect(await state.device.verifyFirmwareUpdateBoot({ serialNumber: expected.serialNumber, versionNumber: expected.versionNumber, customRecording: true })).toMatchObject({ status: 'unavailable', reason: 'source-version-unavailable' })
    expect(state.commands).toEqual([])
    expect(state.device.getFirmwareUploadFence()).toBe('uploaded')
  })
  it('keeps uncertain fence after deadline silence and does not retry', async () => {
    const state = setup(() => null); state.internals.firmwareUploadFence = 'uncertain'
    const result = await state.device.verifyFirmwareUpdateBoot(expected, 0.02)
    expect(result).toMatchObject({ status: 'unavailable', imageAttested: false })
    expect(state.commands).toEqual([1])
    expect(state.device.getFirmwareUploadFence()).toBe('uncertain')
  })
  it('allows correlated read-only identity while uncertain but never clears its fence prematurely', async () => {
    const state = setup(); state.internals.firmwareUploadFence = 'uncertain'
    expect(await state.device.getDeviceInfo()).toMatchObject({ serialNumber: expected.serialNumber, versionNumber: expected.versionNumber })
    expect(state.device.getFirmwareUploadFence()).toBe('uncertain')
    expect(await state.device.setAutoRecord(true)).toBeNull()
    expect(state.commands).toEqual([1])
    expect(await state.device.verifyFirmwareUpdateBoot(expected)).toMatchObject({ status: 'confirmed' })
  })
  it('stock restoration reads native idle/card without sending custom control queries', async () => {
    const state = setup((command, _sequence, body) => { if (command === 1) body[3] = 0; return body })
    expect(await state.device.verifyFirmwareUpdateBoot({ ...expected, versionNumber: 393984, customRecording: false, sourceVersionNumber: 393985 })).toMatchObject({ status: 'confirmed' })
    expect(state.commands).toEqual([1, 29, 18, 16])
  })
})
