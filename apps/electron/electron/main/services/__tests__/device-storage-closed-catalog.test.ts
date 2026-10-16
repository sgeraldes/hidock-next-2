// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { DeviceStorage } from '../device-storage'
import type { FileInfo, FileListingResult, JensenDevice } from '@hidock/jensen-protocol'

type Serializer = <T>(operation: () => Promise<T>) => Promise<T>
type RecordingSnapshot = { recording: string | null } | null

const serialNumber = 'CLOSED-CATALOG-QA-DEVICE'
const deviceHash = createHash('sha256').update(serialNumber).digest('hex')

function file(name: string): FileInfo {
  return { name, createDate: '2026-10-12', createTime: '12:00:00', time: null, duration: 1, version: 1, length: 4096, signature: '0123456789abcdef0123456789abcdef' }
}
function listing(files: FileInfo[] = [file('REC00001.wav'), file('REC00002.hda')]): FileListingResult {
  return { status: 'complete', files, expectedCount: files.length, parsedCount: files.length, reason: null }
}

function fixture(options: {
  recordingSnapshots?: RecordingSnapshot[]
  listing?: FileListingResult | null
  info?: { serialNumber: string; versionNumber: number; versionCode: string; model: any } | null
  connected?: boolean
  epoch?: number
  onListing?: () => void | Promise<void>
  onNativeCall?: () => void
  serialize?: Serializer
} = {}) {
  const state = { connected: options.connected ?? true, epoch: options.epoch ?? 17 }
  const responses = [...(options.recordingSnapshots ?? Array.from({ length: 8 }, () => ({ recording: null })))]
  const listResult = options.listing === undefined ? listing() : options.listing
  const api = {
    isConnected: vi.fn(() => { options.onNativeCall?.(); return state.connected }),
    getConnectionSessionId: vi.fn(() => { options.onNativeCall?.(); return state.epoch }),
    getDeviceInfo: vi.fn(async () => { options.onNativeCall?.(); return options.info === undefined ? {
      serialNumber, versionNumber: 1, versionCode: 'qa', model: 'H1' as any
    } : options.info }),
    getRecordingFile: vi.fn(async () => { options.onNativeCall?.(); return responses.length ? responses.shift()! : null }),
    listFilesDetailed: vi.fn(async () => { options.onNativeCall?.(); await options.onListing?.(); return listResult })
  }
  const device = api as unknown as JensenDevice
  const serialize = options.serialize ?? (async <T>(operation: () => Promise<T>) => operation())
  return { state, api, storage: new DeviceStorage(() => device, serialize) }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('DeviceStorage.closedCatalog whole-inventory boundary', () => {
  it('returns a complete idle catalog with identity and all listed files', async () => {
    const f = fixture()
    const result = await f.storage.closedCatalog()
    expect(result).toMatchObject({ complete: true, deviceId: deviceHash, files: [{ name: 'REC00001.wav' }, { name: 'REC00002.hda' }] })
    expect(result.sessionId).toMatch(/:17$/)
    expect(f.api.getRecordingFile).toHaveBeenCalledTimes(2)
    expect(f.api.listFilesDetailed).toHaveBeenCalledTimes(1)
  })

  it('refuses an active-before snapshot before asking native firmware for the listing', async () => {
    const f = fixture({ recordingSnapshots: [{ recording: 'ACTIVE0001.wav' }, { recording: null }] })
    await expect(f.storage.closedCatalog()).rejects.toThrow(/idle, complete native catalog/)
    expect(f.api.listFilesDetailed).not.toHaveBeenCalled()
  })

  it('refuses when recording starts during the listing interval', async () => {
    const f = fixture({ recordingSnapshots: [{ recording: null }, { recording: 'STARTED001.wav' }] })
    await expect(f.storage.closedCatalog()).rejects.toThrow(/idle, complete native catalog/)
    expect(f.api.listFilesDetailed).toHaveBeenCalledTimes(1)
    expect(f.api.getRecordingFile).toHaveBeenCalledTimes(2)
  })

  it('refuses a disconnect or changed connection epoch during listing', async () => {
    const disconnected = fixture({ onListing: () => { disconnected.state.connected = false } })
    await expect(disconnected.storage.closedCatalog()).rejects.toThrow(/complete stable device catalog/)

    const changedEpoch = fixture({ onListing: () => { changedEpoch.state.epoch++ } })
    await expect(changedEpoch.storage.closedCatalog()).rejects.toThrow(/complete stable device catalog/)
  })

  it('fails closed for missing identity, missing recording state, and partial or absent listings', async () => {
    const noInfo = fixture({ info: null })
    await expect(noInfo.storage.closedCatalog()).rejects.toThrow(/catalog/)

    const noRecordingState = fixture({ recordingSnapshots: [null] })
    await expect(noRecordingState.storage.closedCatalog()).rejects.toThrow(/catalog/)

    const partial = fixture({ listing: { ...listing(), status: 'partial', reason: 'not all rows parsed' } })
    await expect(partial.storage.closedCatalog()).rejects.toThrow(/complete stable device catalog/)

    const absentListing = fixture({ listing: null })
    await expect(absentListing.storage.closedCatalog()).rejects.toThrow()
  })

  it('preserves the browsing catalog filter for the currently active filename', async () => {
    const active = 'REC00001.wav'
    const f = fixture({ recordingSnapshots: [{ recording: active }], listing: listing([file(active), file('REC00002.hda')]) })
    const result = await f.storage.catalog()
    expect(result.files.map(value => value.name)).toEqual(['REC00002.hda'])
    expect(f.api.getRecordingFile).toHaveBeenCalledTimes(1)
  })

  it('holds one injected serializer slot over each full closed snapshot', async () => {
    let active = 0
    let maximum = 0
    let serializerCalls = 0
    let listCalls = 0
    let tail: Promise<void> = Promise.resolve()
    const entered = deferred<void>()
    const releaseFirst = deferred<void>()
    const serialize: Serializer = <T>(operation: () => Promise<T>): Promise<T> => {
      serializerCalls++
      const result = tail.then(async () => {
        active++
        maximum = Math.max(maximum, active)
        try { return await operation() } finally { active-- }
      })
      tail = result.then(() => undefined, () => undefined)
      return result
    }
    const f = fixture({
      serialize,
      onNativeCall: () => expect(active).toBe(1),
      onListing: async () => {
        listCalls++
        if (listCalls === 1) { entered.resolve(); await releaseFirst.promise }
      }
    })
    const first = f.storage.closedCatalog()
    await entered.promise
    const second = f.storage.closedCatalog()
    await Promise.resolve()
    expect(listCalls).toBe(1)
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(serializerCalls).toBe(2)
    expect(maximum).toBe(1)
    expect(listCalls).toBe(2)
  })
})
