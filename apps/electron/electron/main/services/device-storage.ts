import { createHash, randomUUID } from 'node:crypto'
import type { JensenDevice, FileInfo, FileListingResult, FileRangeResult } from '@hidock/jensen-protocol'
import type { DeviceFsCatalog, DeviceFsFile, DeviceFsStore } from './device-file-system'
import type { ResumeSource, ResumeAdapter } from './download-resume'

/** All calls use the application owner. This class never opens a USB handle. */
export class DeviceStorage implements DeviceFsStore {
  private readonly processId = randomUUID()
  constructor(private readonly device: () => JensenDevice,
    private readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>) {}

  private session(): string {
    return `${this.processId}:${this.device().getConnectionSessionId()}`
  }
  private async snapshot(requireAllClosed = false): Promise<{ catalog: DeviceFsCatalog; raw: FileInfo[]; firmware: string; model: string }> {
    const device = this.device()
    if (!device.isConnected()) throw Error('Device is disconnected')
    const sessionId = this.session()
    const info = await device.getDeviceInfo()
    const active = await device.getRecordingFile()
    if (requireAllClosed && (!info?.serialNumber || !active || active.recording !== null)) {
      throw Error('Whole backup requires an idle, complete native catalog')
    }
    const listing = await device.listFilesDetailed()
    if (!info?.serialNumber || !active || listing.status !== 'complete' || !device.isConnected() || sessionId !== this.session()) {
      throw Error('A complete stable device catalog is required')
    }
    if (requireAllClosed) {
      const after = await device.getRecordingFile()
      if (active.recording !== null || !after || after.recording !== null || !device.isConnected() || sessionId !== this.session()) {
        throw Error('Whole backup requires an idle, complete native catalog')
      }
    }
    const files = listing.files.filter(file => file.name !== active.recording)
    const deviceId = createHash('sha256').update(info.serialNumber).digest('hex')
    return { catalog: { complete: true, deviceId, sessionId,
      files: files.map(file => ({ name: file.name, size: file.length, signature: file.signature, modified: file.time })) },
    raw: files, firmware: `${info.versionNumber}:${info.versionCode}`, model: info.model }
  }
  catalog(): Promise<DeviceFsCatalog> { return this.serialize(async () => (await this.snapshot()).catalog) }
  /** Unlike browsing, a whole-backup plan must never silently omit an active file. */
  closedCatalog(): Promise<DeviceFsCatalog> { return this.serialize(async () => (await this.snapshot(true)).catalog) }
  list(): Promise<FileListingResult> { return this.serialize(() => this.device().listFilesDetailed()) }
  page(firstIndex: number, count: number) {
    return this.serialize(async () => {
      const device = this.device()
      if (!device.isConnected()) throw Error('Device is disconnected')
      const sessionId = this.session()
      const info = await device.getDeviceInfo()
      if (!info || !device.isConnected() || sessionId !== this.session()) throw Error('Fresh stable device identity is required')
      return device.listFilesPage(firstIndex, count)
    })
  }
  source(filename: string): Promise<ResumeSource> {
    return this.serialize(async () => {
      const value = await this.snapshot()
      const file = value.raw.find(file => file.name === filename)
      if (!file) throw Error('Completed file is absent from the current catalog')
      return { deviceId: value.catalog.deviceId, sessionId: value.catalog.sessionId,
        model: value.model, firmware: value.firmware, filename, size: file.length,
        signature: file.signature, listingComplete: true, completed: true }
    })
  }
  adapter(filename: string, onSettled?: () => void): ResumeAdapter {
    return { snapshot: () => this.source(filename), readRange: (name, size, offset, count, onChunk, signal, onStarted) =>
      this.range(name, size, offset, count, onChunk, signal, onStarted, onSettled) }
  }
  range(filename: string, size: number, offset: number, count: number,
    onChunk: (chunk: Uint8Array) => void, signal?: AbortSignal, onStarted?: () => void, onSettled?: () => void, prefix = false): Promise<FileRangeResult> {
    return this.serialize(async () => {
      const device = this.device()
      if (signal?.aborted) throw Error('Device read cancelled')
      try { return prefix ? await device.readFilePrefix(filename, size, count, onChunk, undefined, signal, onStarted) :
        await device.readFileRange(filename, size, offset, count, onChunk, undefined, signal, onStarted) }
      finally { await device.getActiveDownloadSettlement(); onSettled?.() }
    })
  }
  read(file: DeviceFsFile, offset: number, count: number, signal: AbortSignal): Promise<Uint8Array> {
    return this.serialize(async () => {
      if (signal.aborted) throw Error('Filesystem read cancelled')
      const fresh = await this.snapshot()
      const current = fresh.raw.find(value => value.name === file.name)
      if (!current || current.length !== file.size || current.signature !== file.signature) throw Error('Device file changed')
      const output = new Uint8Array(count)
      let received = 0
      const device = this.device()
      try {
        const result = await device.readFileRange(file.name, file.size, offset, count, chunk => {
          if (received + chunk.byteLength > count) throw Error('Range exceeds its exact boundary')
          output.set(chunk, received); received += chunk.byteLength
        }, undefined, signal)
        if (result.status !== 'complete' || received !== count || this.session() !== fresh.catalog.sessionId) throw Error('Device range is incomplete or session changed')
        return output
      } finally { await device.getActiveDownloadSettlement() }
    })
  }
}
