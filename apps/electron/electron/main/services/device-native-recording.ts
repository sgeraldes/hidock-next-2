import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { DeviceNativeRecordingStatus, NativeRecordingRequest, NativeRecordingDispatch } from '../../../src/shared/device-native-recording'

interface NativeDevice {
  getModel(): string
  versionCode: string | null
  versionNumber: number | null
  serialNumber: string | null
  isConnected(): boolean
  getRecordingStatus(): Promise<DeviceNativeRecordingStatus | null>
  getRecordingFile(): Promise<{ recording: string | null } | null>
  addNativeMarker(): Promise<{ result: string } | null>
  toggleNativeRecording(): Promise<{ result: string } | null>
}
interface Dependencies {
  device(): NativeDevice
  busy(): boolean
  liveIdle(): boolean
  serialize<T>(operation: () => Promise<T>): Promise<T>
  directory(): string
  protectNewFile?(filename: string): Promise<void>
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const qualifiedNativeVersion = (device: NativeDevice): boolean =>
  device.versionNumber === 393984 && device.versionCode === '6.3.0' ||
  device.versionNumber === 393985 && device.versionCode === '6.3.1' ||
  device.versionNumber === 393986 && device.versionCode === '6.3.2' ||
  device.versionNumber === 393987 && device.versionCode === '6.3.3' ||
  device.versionNumber === 393988 && device.versionCode === '6.3.4'

/** Commands use the sole USB owner. A durable reservation prevents retrying a non-idempotent key. */
export class DeviceNativeRecordingControl {
  constructor(private readonly deps: Dependencies) {}

  private device(): NativeDevice {
    const device = this.deps.device()
    if (!device.isConnected() || device.getModel() !== 'hidock-h1e' || !qualifiedNativeVersion(device)) throw new Error('Native controls require H1E stock 6.3.0, qualified REA1 custom 6.3.1/6.3.2/6.3.4, or qualified forward stock 6.3.3')
    if (this.deps.busy()) throw new Error('The device is busy with another USB operation')
    return device
  }

  private async read(device: NativeDevice): Promise<DeviceNativeRecordingStatus> {
    const status = await device.getRecordingStatus()
    if (!status) throw new Error('Native recording status is unknown; no control command was sent')
    // CMD29 can return an empty body after allocation failure. Confirm idle with CMD18.
    if (status.recording === null) {
      const corroboration = await device.getRecordingFile()
      if (!corroboration || corroboration.recording !== null) throw new Error('Native idle status could not be confirmed')
    }
    return status
  }

  status(): Promise<DeviceNativeRecordingStatus> {
    return this.deps.serialize(() => this.read(this.device()))
  }

  /** Keep the fresh read and CMD33 ordered together; never finalize an existing native file. */
  startLive<T>(start: () => Promise<T>, canStart: () => boolean = () => true): Promise<T> {
    return this.deps.serialize(async () => {
      const device = this.deps.device()
      if (device.getModel() === 'hidock-h1e' && qualifiedNativeVersion(device)) {
        const status = await this.read(this.device())
        if (status.recording !== null) throw new Error('A native recording is active. Stop it before starting live capture')
      } else {
        if (!device.isConnected() || this.deps.busy()) throw new Error('The device is unavailable or busy')
        const status = await device.getRecordingFile()
        if (!status) throw new Error('Native recording status is unknown')
        if (status.recording) throw new Error('A native recording is active. Stop it before starting live capture')
      }
      if (!canStart() || !device.isConnected() || this.deps.busy()) throw new Error('The live request ended before starting')
      return start()
    })
  }

  startVerification(request: NativeRecordingRequest): Promise<NativeRecordingDispatch> {
    if (request?.expectedRecording !== null || !this.deps.protectNewFile) return Promise.reject(new Error('Verification requires a new native recording and file protection'))
    return this.dispatch('toggle', request, true)
  }

  dispatch(operation: 'marker' | 'toggle', request: NativeRecordingRequest, verification = false): Promise<NativeRecordingDispatch> {
    if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['requestId', 'expectedRecording'].includes(key)) || !UUID.test(request.requestId) || (request.expectedRecording !== null && (typeof request.expectedRecording !== 'string' || !request.expectedRecording.trim() || request.expectedRecording.length > 512)) || (operation === 'marker' && request.expectedRecording === null)) return Promise.reject(new Error('Invalid native recording request'))
    return this.deps.serialize(async () => {
      const device = this.device()
      if (!device.serialNumber) throw new Error('Device identity is unavailable')
      const serialNumber = device.serialNumber
      if (!this.deps.liveIdle()) throw new Error('Stop live capture before using native recording controls')
      const key = createHash('sha256').update(`${device.serialNumber}\0${request.requestId.toLowerCase()}`).digest('hex')
      const fingerprint = createHash('sha256').update(`${verification ? 'verification-start' : operation}\0${request.expectedRecording ?? ''}`).digest('hex')
      const destination = join(this.deps.directory(), `${key}.json`)
      await fs.mkdir(this.deps.directory(), { recursive: true })
      let reservation
      try { reservation = await fs.open(destination, 'wx') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const handle = await fs.open(destination, 'r')
        let previous: { fingerprint: string; status: 'acknowledged' | 'inconclusive' | 'rejected' }
        try {
          if ((await handle.stat()).size > 1024) throw new Error('Invalid native command journal', { cause: error })
          previous = JSON.parse(await handle.readFile('utf8'))
        } finally { await handle.close() }
        if (previous.fingerprint !== fingerprint || !['acknowledged', 'inconclusive', 'rejected'].includes(previous.status)) throw new Error('Native request identity was reused or its journal is invalid', { cause: error })
        return { status: 'duplicate', previousStatus: previous.status, persistence: 'unverified' }
      }
      // Persist before any control write. Crash/timeout never causes an automatic resend.
      try { await reservation.writeFile(JSON.stringify({ fingerprint, status: 'inconclusive' })); await reservation.sync() }
      finally { await reservation.close() }
      const status = await this.read(device)
      if (status.recording !== request.expectedRecording) throw new Error('The native recording changed; no control command was sent')
      if (!this.deps.liveIdle() || this.deps.busy() || !device.isConnected() || device.serialNumber !== serialNumber) throw new Error('The device became unavailable or changed; no control command was sent')
      let result: NativeRecordingDispatch = { status: 'inconclusive', persistence: 'unverified' }
      try {
        const reply = operation === 'marker' ? await device.addNativeMarker() : await device.toggleNativeRecording()
        result = { status: reply?.result === 'success' ? 'acknowledged' : reply?.result === 'failed' ? 'rejected' : 'inconclusive', persistence: 'unverified' }
      } catch { /* Reservation remains inconclusive; this non-idempotent command is never retried. */ }
      const temporary = `${destination}.tmp`
      const handle = await fs.open(temporary, 'wx')
      try { await handle.writeFile(JSON.stringify({ fingerprint, status: result.status })); await handle.sync() }
      finally { await handle.close() }
      await fs.rename(temporary, destination)
      // Hold the sole-owner operation chain until the new verification file is
      // protected. Automatic scans/downloads cannot discover it in this gap.
      if (verification && result.status === 'acknowledged') {
        try {
          for (let attempt = 0; attempt < 6; attempt++) {
            const active = await this.read(device)
            if (active.recording) {
              result.recording = active.recording
              await this.deps.protectNewFile!(active.recording)
              result.manualOnly = true
              break
            }
            await new Promise(resolve => setTimeout(resolve, 200))
          }
          if (!result.recording) result.error = 'The queued recording start did not produce an active file'
        } catch (error) { result.error = error instanceof Error ? error.message : String(error) }
      }
      return result
    })
  }
}
