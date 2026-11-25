// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceInfo, DeviceModel, FileInfo, FileListingResult, JensenDevice, RecordingRestoreSession } from '@hidock/jensen-protocol'
import { readOwnedRecordingRestore, RECORDING_RESTORE_READBACK_RANGE_BYTES as MB } from '../device-recording-restore-readback'

function fixture(size = 5) {
  const data = Uint8Array.from({ length: size }, (_, i) => (i * 13 + (i >>> 10)) & 255), epoch = { value: 1 }
  const session: RecordingRestoreSession = { restoreId: 1, ownerToken: Uint8Array.of(1, ...new Array(15).fill(0)), totalBytes: size,
    wholeCrc32: 0, sourceSha256: Uint8Array.from(createHash('sha256').update(data).digest()), filename: 'owned.wav',
    serialNumber: 'SYNTHETIC-READBACK', connectionSessionId: 1, versionNumber: 393988 }
  const file: FileInfo = { name: session.filename, length: size, version: 1, signature: 'stable-prefix', createDate: '', createTime: '', time: null, duration: 0 }
  const listing: FileListingResult = { status: 'complete', expectedCount: 1, parsedCount: 1, files: [file], reason: null }
  const device = { isConnected: () => true, getModel: (): DeviceModel => 'hidock-h1e', getConnectionSessionId: () => epoch.value,
    serialNumber: session.serialNumber, versionNumber: 393988, versionCode: '6.3.4',
    getDeviceInfo: vi.fn(async (): Promise<DeviceInfo | null> => ({ model: 'hidock-h1e', serialNumber: session.serialNumber, versionNumber: 393988, versionCode: '6.3.4' })),
    getRecordingFile: vi.fn(async () => ({ recording: null as string | null })), listFilesDetailed: vi.fn(async () => listing),
    getActiveDownloadSettlement: vi.fn(() => null as Promise<void> | null),
    readFileRange: vi.fn<JensenDevice['readFileRange']>(async (_name, _size, offset, count, chunk, _progress, signal, start) => {
      start?.()
      if (signal?.aborted) return { status: 'cancelled', offset, count, received: 0, reason: 'cancelled' }
      chunk(data.subarray(offset, offset + count))
      return { status: 'complete', offset, count, received: count, reason: null }
    }) }
  return { device, session, data, epoch, file, listing }
}
describe('owned restore readback under an existing caller serializer', () => {
  it('streams synchronized bounded sequential ranges with exact full SHA and one actual-slot activation', async () => {
    const f = fixture(2 * MB + 17), hash = createHash('sha256'), start = vi.fn()
    expect(await readOwnedRecordingRestore(f.device, f.session, bytes => hash.update(bytes), undefined, start)).toEqual({ status: 'complete', received: f.data.length })
    expect(hash.digest('hex')).toBe(Buffer.from(f.session.sourceSha256).toString('hex'))
    expect(f.device.readFileRange.mock.calls.map(call => [call[2], call[3]])).toEqual([[0, MB], [MB, MB], [2 * MB, 17]])
    expect(start).toHaveBeenCalledOnce(); expect(f.device.getActiveDownloadSettlement).toHaveBeenCalledTimes(3)
    expect(f.device.getDeviceInfo).toHaveBeenCalledTimes(2); expect(f.device.getRecordingFile).toHaveBeenCalledTimes(2); expect(f.device.listFilesDetailed).toHaveBeenCalledTimes(2)
  })
  it('supports empty file readback with fresh catalog checks and no range or activation', async () => {
    const f = fixture(0), consume = vi.fn(), start = vi.fn()
    expect(await readOwnedRecordingRestore(f.device, f.session, consume, undefined, start)).toEqual({ status: 'complete', received: 0 })
    expect(f.device.getDeviceInfo).toHaveBeenCalledTimes(2); expect(f.device.listFilesDetailed).toHaveBeenCalledTimes(2)
    expect(f.device.readFileRange).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
  })
  it.each(['partial', 'count', 'missing', 'duplicate', 'size', 'native-active', 'identity'])('rejects invalid initial%s snapshot before any range', async problem => {
    const f = fixture(), consume = vi.fn()
    if (problem === 'partial') f.listing.status = 'partial'
    if (problem === 'count') f.listing.expectedCount = 2
    if (problem === 'missing') f.file.name = 'other.wav'
    if (problem === 'duplicate') { f.listing.files.push({ ...f.file }); f.listing.expectedCount = 2; f.listing.parsedCount = 2 }
    if (problem === 'size') f.file.length++
    if (problem === 'native-active') f.device.getRecordingFile.mockResolvedValue({ recording: 'other-native.hda' })
    if (problem === 'identity') f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', versionNumber: 393988, versionCode: '6.3.4', serialNumber: 'CHANGED' })
    expect(await readOwnedRecordingRestore(f.device, f.session, consume)).toEqual({ status: 'error', received: 0 })
    expect(f.device.readFileRange).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled()
  })
  it.each(['version', 'code', 'model', 'epoch', 'serial', 'disconnected'])('rejects initial%s without querying another device', async problem => {
    const f = fixture()
    if (problem === 'version') f.device.versionNumber = 393986
    if (problem === 'code') f.device.versionCode = '6.3.2'
    if (problem === 'model') f.device.getModel = () => 'hidock-p1'
    if (problem === 'epoch') f.epoch.value++
    if (problem === 'serial') f.device.serialNumber = 'CHANGED'
    if (problem === 'disconnected') f.device.isConnected = () => false
    expect(await readOwnedRecordingRestore(f.device, f.session, vi.fn())).toEqual({ status: 'error', received: 0 })
    expect(f.device.getDeviceInfo).not.toHaveBeenCalled(); expect(f.device.readFileRange).not.toHaveBeenCalled()
  })
  it.each(['overflow', 'truncated', 'reported-size', 'reported-offset', 'reported-count', 'empty-chunk'])('fails exact byte geometry on%s and awaits settlement', async problem => {
    const f = fixture(), consume = vi.fn()
    f.device.readFileRange.mockImplementation(async (_name, _size, offset, count, chunk) => {
      chunk(problem === 'overflow' ? new Uint8Array(count + 1) : problem === 'truncated' ? f.data.subarray(0, 3) : problem === 'empty-chunk' ? new Uint8Array() : f.data)
      return { status: 'complete', offset: problem === 'reported-offset' ? offset + 1 : offset,
        count: problem === 'reported-count' ? count + 1 : count, received: problem === 'reported-size' ? count + 1 : count, reason: null }
    })
    expect((await readOwnedRecordingRestore(f.device, f.session, consume)).status).toBe('error')
    expect(f.device.getActiveDownloadSettlement).toHaveBeenCalledOnce(); expect(f.device.readFileRange).toHaveBeenCalledOnce()
    if (problem === 'overflow' || problem === 'empty-chunk') expect(consume).not.toHaveBeenCalled()
  })
  it('rejects a changed epoch immediately after identity lookup before later metadata or data', async () => {
    const f = fixture(), original = f.device.getDeviceInfo.getMockImplementation()!
    f.device.getDeviceInfo.mockImplementation(async () => { const result = await original(); f.epoch.value++; return result })
    expect(await readOwnedRecordingRestore(f.device, f.session, vi.fn())).toEqual({ status: 'error', received: 0 })
    expect(f.device.getRecordingFile).not.toHaveBeenCalled(); expect(f.device.readFileRange).not.toHaveBeenCalled()
  })
  it('rejects a changed owner at the actual SDK start hook before activation or bytes', async () => {
    const f = fixture(), activate = vi.fn(), consume = vi.fn()
    f.device.readFileRange.mockImplementation(async (_name, _size, offset, count, chunk, _progress, _signal, started) => {
      f.epoch.value++; started?.(); chunk(f.data); return { status: 'complete', offset, count, received: count, reason: null }
    })
    expect(await readOwnedRecordingRestore(f.device, f.session, consume, undefined, activate)).toEqual({ status: 'error', received: 0 })
    expect(activate).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled(); expect(f.device.getActiveDownloadSettlement).toHaveBeenCalledOnce()
  })
  it('rejects midstream identity changes and never forwards later chunks or retries', async () => {
    const f = fixture(), chunks: Uint8Array[] = []
    f.device.readFileRange.mockImplementation(async (_name, _size, offset, count, chunk) => {
      chunk(f.data.subarray(0, 2)); f.device.serialNumber = 'CHANGED'; chunk(f.data.subarray(2))
      return { status: 'complete', offset, count, received: count, reason: null }
    })
    expect(await readOwnedRecordingRestore(f.device, f.session, bytes => chunks.push(bytes))).toEqual({ status: 'error', received: 2 })
    expect(chunks.map(bytes => bytes.length)).toEqual([2]); expect(f.device.readFileRange).toHaveBeenCalledOnce()
  })
  it.each(['size', 'signature', 'version', 'native-active', 'partial-catalog', 'epoch'])('rejects end-of-read%s changes despite exact data', async problem => {
    const f = fixture(), read = f.device.readFileRange.getMockImplementation()!
    f.device.readFileRange.mockImplementation(async (...args) => {
      const result = await read(...args)
      if (problem === 'size') f.file.length++
      if (problem === 'signature') f.file.signature = 'new-prefix'
      if (problem === 'version') f.file.version++
      if (problem === 'native-active') f.device.getRecordingFile.mockResolvedValue({ recording: 'other-native.hda' })
      if (problem === 'partial-catalog') f.listing.status = 'partial'
      if (problem === 'epoch') f.epoch.value++
      return result
    })
    expect(await readOwnedRecordingRestore(f.device, f.session, vi.fn())).toEqual({ status: 'error', received: 5 })
    expect(f.device.readFileRange).toHaveBeenCalledOnce(); expect(f.device.getActiveDownloadSettlement).toHaveBeenCalledOnce()
  })
  it('returns pre-cancel without IO and start-cancel before forwarding any bytes', async () => {
    const f = fixture(), cancel = new AbortController(), consume = vi.fn(); cancel.abort()
    expect(await readOwnedRecordingRestore(f.device, f.session, consume, cancel.signal)).toEqual({ status: 'cancelled', received: 0 })
    expect(f.device.getDeviceInfo).not.toHaveBeenCalled()
    const during = new AbortController()
    expect(await readOwnedRecordingRestore(f.device, f.session, consume, during.signal, () => during.abort())).toEqual({ status: 'cancelled', received: 0 })
    expect(consume).not.toHaveBeenCalled(); expect(f.device.getActiveDownloadSettlement).toHaveBeenCalledOnce()
  })
  it('returns midstream cancel and waits for the actual drain settlement before handing owner back', async () => {
    const f = fixture(), cancel = new AbortController()
    let finish!: () => void
    const settlement = new Promise<void>(resolve => { finish = resolve })
    f.device.getActiveDownloadSettlement.mockReturnValue(settlement)
    f.device.readFileRange.mockImplementation(async (_name, _size, offset, count, chunk) => {
      chunk(f.data.subarray(0, 2)); return { status: 'cancelled', offset, count, received: 2, reason: 'cancelled' }
    })
    let handedBack = false
    const read = readOwnedRecordingRestore(f.device, f.session, () => cancel.abort(), cancel.signal).then(result => { handedBack = true; return result })
    await vi.waitFor(() => expect(f.device.getActiveDownloadSettlement).toHaveBeenCalledOnce())
    expect(handedBack).toBe(false); finish()
    expect(await read).toEqual({ status: 'cancelled', received: 2 }); expect(f.device.readFileRange).toHaveBeenCalledOnce()
  })
  it('fails consumer or settlement exceptions without claiming acceptance or retrying', async () => {
    const consumer = fixture()
    expect(await readOwnedRecordingRestore(consumer.device, consumer.session, () => { throw Error('consumer') })).toEqual({ status: 'error', received: 5 })
    expect(consumer.device.getActiveDownloadSettlement).toHaveBeenCalledOnce()
    const drain = fixture(); drain.device.getActiveDownloadSettlement.mockImplementation(() => Promise.reject(Error('settlement')))
    expect(await readOwnedRecordingRestore(drain.device, drain.session, vi.fn())).toEqual({ status: 'error', received: 5 })
    expect(drain.device.readFileRange).toHaveBeenCalledOnce()
  })
})
