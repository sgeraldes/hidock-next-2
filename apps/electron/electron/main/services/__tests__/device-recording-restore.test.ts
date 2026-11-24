/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { ownedScratchCrc32, parseRecordingRestoreReply } from '@hidock/jensen-protocol'
import type { CardInfo, RecordingRestoreDescriptor, RecordingRestoreOperation, RecordingRestoreReply, RecordingRestoreRequest, RecordingRestoreSession, RecordingRestoreWriteOptions, RecordingRestoreWriteOutcome } from '@hidock/jensen-protocol'
import { DeviceRecordingRestoreService } from '../device-recording-restore'
import { DeviceRecordingRestoreJournal } from '../device-recording-restore-journal'
import { serializeDeviceOperation } from '../device-operation-serializer'

const dirs: string[] = [], assurance = { ownedRecordingRestoreConsent: true as const, audioQuiescent: true as const }
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('hidock-recording-restore-')) throw Error('Unsafe fixture cleanup')
    rmSync(dir, { recursive: true, force: true })
  }
})
function reply(s: RecordingRestoreSession, request: RecordingRestoreRequest, state: number, uploaded: number, verified: number, reason = 0): RecordingRestoreReply {
  const bytes = new Uint8Array(53 + s.filename.length), v = new DataView(bytes.buffer)
  bytes[0] = reason ? 1 : 0; bytes[1] = state; v.setUint16(2, reason)
  v.setUint32(4, uploaded); v.setUint32(8, verified); v.setUint32(12, s.totalBytes); v.setUint32(16, s.wholeCrc32)
  bytes.set(s.sourceSha256, 20); bytes[52] = s.filename.length; bytes.set(new TextEncoder().encode(s.filename), 53)
  const value = parseRecordingRestoreReply(s, request, bytes); if (!value) throw Error('Invalid modeled response'); return value
}
function fixture(size = 1025) {
  const dir = mkdtempSync(join(tmpdir(), 'hidock-recording-restore-')); dirs.push(dir)
  const path = join(dir, 'library-storage-uuid.bin'), bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  writeFileSync(path, bytes)
  const state = { available: true, idle: true, normal: true, msc: true, connected: true, owner: true, epoch: 1, version: 393988, serial: 'PRIVATE-SERIAL' }
  // Real temporary filesystem; AES-GCM models the injected OS sealing facade.
  const key = randomBytes(32), sealed = {
    isEncryptionAvailable: () => state.available,
    encryptString: (text: string) => { const nonce = randomBytes(12), c = createCipheriv('aes-256-gcm', key, nonce); const data = Buffer.concat([c.update(text), c.final()]); return Buffer.concat([nonce, c.getAuthTag(), data]) },
    decryptString: (data: Buffer) => { const c = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); c.setAuthTag(data.subarray(12, 28)); return Buffer.concat([c.update(data.subarray(28)), c.final()]).toString('utf8') }
  }
  const journal = new DeviceRecordingRestoreJournal(join(dir, 'sealed'), sealed)
  const native = new Map<number, { descriptor: RecordingRestoreSession; bytes: Buffer; state: number; uploaded: number; verified: number; step: number; reason: number }>()
  const device = {
    get serialNumber() { return state.serial }, get versionNumber() { return state.version }, get versionCode() { return state.version === 393988 ? '6.3.4' : '6.3.2' },
    getModel: () => 'hidock-h1e' as const, isConnected: () => state.connected, getConnectionSessionId: () => state.epoch,
    getDeviceInfo: vi.fn(async () => ({ serialNumber: state.serial, versionNumber: state.version, versionCode: device.versionCode, model: 'hidock-h1e' as const })),
    getCardInfo: vi.fn(async (): Promise<CardInfo> => ({ capacity: 1024, used: 24, free: 1000, status: '900' })),
    createRecordingRestoreSession: vi.fn((d: RecordingRestoreDescriptor): RecordingRestoreSession => ({ ...d, ownerToken: d.ownerToken.slice(), sourceSha256: d.sourceSha256.slice(), serialNumber: state.serial, connectionSessionId: state.epoch, versionNumber: 393988 })),
    applyRecordingRestore: vi.fn(async (s: RecordingRestoreSession, request: RecordingRestoreOperation, _options: RecordingRestoreWriteOptions): Promise<RecordingRestoreWriteOutcome> => {
      if (request.operation === 'begin') native.set(s.restoreId, { descriptor: s, bytes: Buffer.alloc(s.totalBytes), state: 1, uploaded: 0, verified: 0, step: 0, reason: 0 })
      const n = native.get(s.restoreId)!; if (!n) throw Error('No modeled native owner')
      if (request.operation === 'append') { n.bytes.set(request.data, request.offset); n.uploaded += request.data.length }
      if (request.operation === 'abort') { n.state = 0; n.uploaded = 0; n.verified = 0 }
      if (request.operation === 'recover-step') { n.state = 1; n.verified = 0; n.reason = 0 }
      if (request.operation === 'verify-commit-step') { n.state = [2, 3, 4, 5][Math.min(n.step++, 3)]; n.verified = n.state === 4 ? 0 : s.totalBytes }
      return { status: 'reply', commandAttempted: true, reply: reply(s, request, n.state, n.uploaded, n.verified) }
    }),
    getRecordingRestoreStatus: vi.fn(async (s: RecordingRestoreSession): Promise<RecordingRestoreReply | null> => {
      const n = native.get(s.restoreId); return n ? reply(s, { operation: 'status' }, n.state, n.uploaded, n.verified, n.reason) : null
    })
  }
  const deps = { device: () => device, serialize: serializeDeviceOperation, idle: () => state.idle, normalJensen: () => state.normal,
    massStorageInactive: () => state.msc, ownerAvailable: () => state.owner,
    // sha256 stands in for the stored original-backup receipt: the digest of the bytes the host received.
    getTrustedSource: vi.fn(async (id: string) => id === 'library-record-id' ? { path, filename: '2026Oct12-111955-Rec83.wav', sha256: createHash('sha256').update(bytes).digest('hex') } : null), journal,
    readback: vi.fn(async (s: RecordingRestoreSession, chunk: (data: Uint8Array) => void): Promise<{ status: 'complete' | 'cancelled' | 'error'; received: number }> => { const n = native.get(s.restoreId)!; for (let i = 0; i < n.bytes.length; i += 512) chunk(n.bytes.subarray(i, i + 512)); return { status: 'complete' as const, received: n.bytes.length } }),
    processId: randomUUID() }
  const service = new DeviceRecordingRestoreService(deps)
  const begin = async () => { const r = await service.begin(1, 'library-record-id', assurance); expect(r.status).toBe('reply'); return r.sessionId! }
  const finish = async (id: string) => {
    for (let offset = 0; offset < size;) { const count = Math.min(1024, size - offset); expect((await service.append(1, id, { offset, count }, assurance)).status).toBe('reply'); offset += count }
    for (let i = 0; i < 4; i++) expect((await service.verifyCommitStep(1, id, assurance)).status).toBe('reply')
  }
  return { dir, path, bytes, state, sealed, journal, native, device, deps, service, begin, finish }
}
describe('future RSTR2 service: actual trusted source and sealed ownership, modeled SDK only', () => {
  it('hashes actual source, seals before BEGIN, reads bounded source chunks and needs full device readback before verification', async () => {
    const f = fixture(), backend = f.device.applyRecordingRestore.getMockImplementation()!
    f.device.applyRecordingRestore.mockImplementationOnce(async (...args) => {
      const files = readdirSync(f.journal.directory); expect(files).toHaveLength(1)
      const record = await f.journal.load(files[0].replace('.rstr2.sealed', ''))
      expect(Buffer.from(record.session.sourceSha256)).toEqual(createHash('sha256').update(f.bytes).digest())
      expect(record.session.wholeCrc32).toBe(ownedScratchCrc32(f.bytes)); expect(record.source.path).toBe(f.path)
      expect(record.session.filename).not.toBe(basename(f.path))
      return backend(...args)
    })
    const id = await f.begin(); await f.finish(id)
    const writes = f.device.applyRecordingRestore.mock.calls.length
    expect((await f.service.status(1, id)).restoreVerified).toBe(false)
    expect((await f.service.abort(1, id, assurance)).reason).toBe('finished-file-protected')
    const result = await f.service.verifyReadback(1, id)
    expect(result).toMatchObject({ status: 'restore-verified', deviceFinished: true, restoreVerified: true })
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(writes)
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SERIAL'); expect(JSON.stringify(result)).not.toContain(f.path)
    expect(result).not.toHaveProperty('ownerToken')
  })
  it('supports empty source with actual empty CRC/SHA and zero-byte readback', async () => {
    const f = fixture(0), id = await f.begin(); await f.finish(id)
    expect((await f.service.verifyReadback(1, id)).restoreVerified).toBe(true)
  })
  it.each(['version', 'encryption', 'idle', 'normal', 'msc', 'connected', 'owner'])('rejects unavailable %s before any SDK call or source lookup', async cause => {
    const f = fixture()
    if (cause === 'version') f.state.version = 393986
    else if (cause === 'encryption') f.state.available = false
    else f.state[cause as 'idle' | 'normal' | 'msc' | 'connected' | 'owner'] = false
    expect((await f.service.begin(1, 'library-record-id', assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyRecordingRestore).not.toHaveBeenCalled(); expect(f.device.getDeviceInfo).not.toHaveBeenCalled(); expect(f.deps.getTrustedSource).not.toHaveBeenCalled()
  })
  it('rejects renderer paths/names, missing consent, unsafe original filename and failed fsync boundary', async () => {
    const f = fixture()
    expect((await f.service.begin(1, f.path, assurance)).status).toBe('rejected-before-dispatch')
    expect((await f.service.begin(1, 'library-record-id', {} as typeof assurance)).status).toBe('rejected-before-dispatch')
    f.deps.getTrustedSource.mockResolvedValueOnce({ path: f.path, filename: '../other.wav', sha256: createHash('sha256').update(f.bytes).digest('hex') })
    expect((await f.service.begin(1, 'library-record-id', assurance)).status).toBe('rejected-before-dispatch')
    vi.spyOn(f.journal, 'create').mockRejectedValueOnce(Error('private path and token'))
    const result = await f.service.begin(1, 'library-record-id', assurance)
    expect(result.status).toBe('rejected-before-dispatch'); expect(JSON.stringify(result)).not.toContain('private path')
    expect(f.device.applyRecordingRestore).not.toHaveBeenCalled()
  })
  it('rejects a same-size local edit made BEFORE begin: the receipt digest no longer matches the bytes on disk', async () => {
    const f = fixture(); writeFileSync(f.path, Buffer.alloc(1025, 0x5a))
    const result = await f.service.begin(1, 'library-record-id', assurance)
    expect(result).toMatchObject({ status: 'rejected-before-dispatch', reason: 'source-changed', sessionId: null })
    expect(f.device.applyRecordingRestore).not.toHaveBeenCalled(); expect(f.device.getDeviceInfo).not.toHaveBeenCalled()
    expect(existsSync(f.journal.directory)).toBe(false) // nothing was ever sealed for this source
    expect(await f.service.hasUnresolvedOwnership()).toBe(false)
  })
  it('fails closed when the trusted source carries no valid receipt digest', async () => {
    for (const sha256 of [undefined, '', 'A'.repeat(64), 'f'.repeat(63)]) {
      const f = fixture(); f.deps.getTrustedSource.mockResolvedValueOnce({ path: f.path, filename: '2026Oct12-111955-Rec83.wav', sha256 } as never)
      expect((await f.service.begin(1, 'library-record-id', assurance)).status).toBe('rejected-before-dispatch')
      expect(f.device.applyRecordingRestore).not.toHaveBeenCalled()
    }
  })
  it('later receipt versions or a different pinned digest fail the next append without rehashing the whole source', async () => {
    const f = fixture(), id = await f.begin(), real = f.deps.getTrustedSource.getMockImplementation()!
    f.deps.getTrustedSource.mockImplementation(async recordingId => { const value = await real(recordingId); return value && { ...value, sha256: 'c'.repeat(64) } })
    expect((await f.service.append(1, id, { offset: 0, count: 1024 }, assurance)).reason).toBe('source-changed')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(1)
  })
  it('rejects changed or replaced source before append and verify without extra native effects', async () => {
    const f = fixture(), id = await f.begin()
    writeFileSync(f.path, Buffer.alloc(1025, 0xff))
    expect((await f.service.append(1, id, { offset: 0, count: 1024 }, assurance)).reason).toBe('source-changed')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(1)
    expect((await f.service.abort(1, id, assurance)).status).toBe('reply') // Explicit owned cleanup can proceed even if source changed.
  })
  it('does not dispatch BEGIN if source changes while sealing or owner disappears after fsync', async () => {
    for (const cause of ['source', 'owner'] as const) {
      const f = fixture(), create = f.journal.create.bind(f.journal)
      vi.spyOn(f.journal, 'create').mockImplementationOnce(async r => { await create(r); if (cause === 'source') writeFileSync(f.path, Buffer.alloc(1025, 0x71)); else f.state.owner = false })
      expect((await f.service.begin(1, 'library-record-id', assurance)).status).toBe('rejected-before-dispatch')
      expect(f.device.applyRecordingRestore).not.toHaveBeenCalled(); expect(readdirSync(f.journal.directory)).toHaveLength(2)
      expect(await f.journal.list()).toEqual([]); expect(await f.service.hasUnresolvedOwnership()).toBe(false)
    }
  })
  it('rejects gaps, unsafe range fields, tiny nonfinal writes and more than1024 bytes', async () => {
    const f = fixture(), id = await f.begin()
    for (const request of [{ offset: 1, count: 512 }, { offset: 0, count: 511 }, { offset: -1, count: 512 }, { offset: 0, count: 1025 }, { offset: 0, count: 512, path: f.path }]) expect((await f.service.append(1, id, request, assurance)).status).toBe('rejected-before-dispatch')
    expect((await f.service.verifyCommitStep(1, id, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(1)
  })
  it('queues source offsets under the shared serializer and never duplicates a competing append', async () => {
    const f = fixture(), id = await f.begin()
    const replies = await Promise.all([f.service.append(1, id, { offset: 0, count: 512 }, assurance), f.service.append(1, id, { offset: 0, count: 512 }, assurance)])
    expect(replies.map(r => r.status)).toEqual(['reply', 'rejected-before-dispatch']); expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(2)
  })
  it('validates a1024-byte append crossing two64KiB source-proof blocks', async () => {
    const f = fixture(66560), id = await f.begin()
    for (let offset = 0; offset < 64512; offset += 1024) expect((await f.service.append(1, id, { offset, count: 1024 }, assurance)).status).toBe('reply')
    await f.service.append(1, id, { offset: 64512, count: 512 }, assurance)
    expect((await f.service.append(1, id, { offset: 65024, count: 1024 }, assurance)).status).toBe('reply')
    const n = [...f.native.values()][0]
    expect(n.bytes.subarray(65024, 66048)).toEqual(f.bytes.subarray(65024, 66048))
    expect(n.uploaded).toBe(66048)
  })
  it('rejects a caller disappearing in the queued serializer slot before disk or SDK work', async () => {
    const f = fixture(); let release!: () => void
    const preceding = serializeDeviceOperation(() => new Promise<void>(r => { release = r }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const queued = f.service.begin(1, 'library-record-id', assurance); f.state.owner = false
    release(); await preceding
    expect((await queued).reason).toBe('application-owner-unavailable')
    expect(f.deps.getTrustedSource).not.toHaveBeenCalled(); expect(f.device.applyRecordingRestore).not.toHaveBeenCalled()
  })
  it('treats an invoked backend exception or dispatched cancellation as uncertain, never retries or returns private details', async () => {
    const f = fixture(), id = await f.begin(), controller = new AbortController(), backend = f.device.applyRecordingRestore.getMockImplementation()!
    f.device.applyRecordingRestore.mockImplementationOnce(async (...args) => { const result = await backend(...args); controller.abort(); return result })
    expect((await f.service.append(1, id, { offset: 0, count: 1024 }, { ...assurance, signal: controller.signal })).status).toBe('uncertain')
    await f.service.status(1, id)
    f.device.applyRecordingRestore.mockRejectedValueOnce(Error('PRIVATE-TOKEN and file path'))
    const failed = await f.service.append(1, id, { offset: 1024, count: 1 }, assurance)
    expect(failed).toMatchObject({ status: 'uncertain', commandAttempted: null })
    expect(JSON.stringify(failed)).not.toContain('PRIVATE-TOKEN')
    expect((await f.service.abort(1, id, assurance)).reason).toBe('explicit-status-required')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(3)
  })
  it('retains uncertain dispatch and requires explicit owned STATUS without retry', async () => {
    const f = fixture(), id = await f.begin(), backend = f.device.applyRecordingRestore.getMockImplementation()!
    f.device.applyRecordingRestore.mockImplementationOnce(async (...args) => { await backend(...args); return { status: 'uncertain', commandAttempted: true, reason: 'lost-ack' } })
    expect((await f.service.append(1, id, { offset: 0, count: 1024 }, assurance)).status).toBe('uncertain')
    expect((await f.service.abort(1, id, assurance)).reason).toBe('explicit-status-required')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(2)
    expect((await f.service.status(1, id)).reply?.metadata?.uploadedBytes).toBe(1024)
    expect((await f.service.append(1, id, { offset: 1024, count: 1 }, assurance)).status).toBe('reply')
  })
  it('recovers sealed ownership only by explicit STATUS, preserving same-process caller and allowing a new process trusted owner', async () => {
    const f = fixture(), id = await f.begin()
    const sameProcess = new DeviceRecordingRestoreService(f.deps)
    expect((await sameProcess.status(2, id.toUpperCase())).status).toBe('status-unavailable')
    const restarted = new DeviceRecordingRestoreService({ ...f.deps, processId: randomUUID() })
    expect((await restarted.append(2, id, { offset: 0, count: 512 }, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.getRecordingRestoreStatus).not.toHaveBeenCalled()
    expect((await restarted.status(2, id)).status).toBe('reply')
    expect((await restarted.append(2, id, { offset: 0, count: 512 }, assurance)).status).toBe('reply')
    expect((await restarted.status(1, id.toUpperCase())).status).toBe('status-unavailable')
  })
  it('requires explicit same-device epoch rebind and rejects a replacement serial', async () => {
    const f = fixture(), id = await f.begin(); f.state.epoch++
    expect((await f.service.append(1, id, { offset: 0, count: 512 }, assurance)).status).toBe('rejected-before-dispatch')
    f.state.serial = 'OTHER'; expect((await f.service.status(1, id)).status).toBe('status-unavailable')
    expect(f.device.getRecordingRestoreStatus).not.toHaveBeenCalled()
    f.state.serial = 'PRIVATE-SERIAL'; expect((await f.service.status(1, id)).status).toBe('reply')
    expect((await f.service.append(1, id, { offset: 0, count: 512 }, assurance)).status).toBe('reply')
  })
  it('does not replay or silently recover interrupted native state; permits one explicit recover step after validated STATUS', async () => {
    const f = fixture(), id = await f.begin(), n = [...f.native.values()][0]
    n.state = 6; n.reason = 8
    expect((await f.service.status(1, id)).reply?.recovery).toBe('explicit-recover-step-required')
    expect((await f.service.verifyCommitStep(1, id, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(1)
    expect((await f.service.recoverStep(1, id, assurance)).status).toBe('reply')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(2)
  })
  it.each(['wrong-sha', 'truncated', 'cancelled', 'epoch', 'owner', 'source'])('never verifies finished metadata alone or bad full readback: %s', async cause => {
    const f = fixture(), id = await f.begin(); await f.finish(id)
    f.deps.readback.mockImplementationOnce(async (_s, onChunk) => {
      if (cause === 'owner') f.state.owner = false
      if (cause === 'epoch') f.state.epoch++
      if (cause === 'source') writeFileSync(f.path, Buffer.alloc(1025, 0x33))
      const bytes = cause === 'wrong-sha' ? Buffer.alloc(1025, 0xfe) : cause === 'truncated' ? f.bytes.subarray(0, 1024) : f.bytes
      onChunk(bytes)
      return { status: cause === 'cancelled' ? 'cancelled' as const : 'complete' as const, received: bytes.length }
    })
    expect((await f.service.verifyReadback(1, id)).restoreVerified).toBe(false)
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(7)
    expect(f.device.getRecordingRestoreStatus).toHaveBeenCalledTimes(1)
  })
  it('fails closed on forged numeric wrapping and short error replies, with no confirmed progress', async () => {
    const f = fixture(), id = await f.begin(), s = f.device.createRecordingRestoreSession.mock.results[0].value
    f.device.getRecordingRestoreStatus.mockResolvedValueOnce({ ...reply(s, { operation: 'status' }, 1, 0, 0), stateCode: 257 })
    expect((await f.service.status(1, id)).status).toBe('status-unavailable')
    const short = parseRecordingRestoreReply(s, { operation: 'status' }, new Uint8Array([1, 1, 0, 8]))!
    f.device.getRecordingRestoreStatus.mockResolvedValueOnce(short)
    expect((await f.service.status(1, id)).reply?.metadata).toBeNull()
    expect((await f.service.abort(1, id, assurance)).reason).toBe('explicit-status-required')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(1)
  })
  it('enumerates restart ownership without native calls, including reboot/version mismatch, and does not release FINISHED', async () => {
    const f = fixture(), id = await f.begin(); await f.finish(id)
    const restarted = new DeviceRecordingRestoreService({ ...f.deps, processId: randomUUID() })
    f.state.epoch++; f.state.version = 393989
    const writes = f.device.applyRecordingRestore.mock.calls.length, info = f.device.getDeviceInfo.mock.calls.length
    expect(await restarted.hasUnresolvedOwnership()).toBe(true)
    expect(f.device.getRecordingRestoreStatus).not.toHaveBeenCalled()
    expect(f.device.getDeviceInfo).toHaveBeenCalledTimes(info); expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(writes)
    expect((await restarted.status(2, id)).status).toBe('status-unavailable')
    f.state.version = 393988
    expect((await restarted.status(2, id)).deviceFinished).toBe(true)
    expect(await restarted.hasUnresolvedOwnership()).toBe(true)
    expect((await restarted.verifyReadback(2, id)).restoreVerified).toBe(true)
    expect(await restarted.hasUnresolvedOwnership()).toBe(false)
    expect(await new DeviceRecordingRestoreService({ ...f.deps, processId: randomUUID() }).hasUnresolvedOwnership()).toBe(false)
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(writes)
  })
  it('releases definitely non-dispatched BEGINs durably and never fills the 16 process leases', async () => {
    const f = fixture()
    f.device.applyRecordingRestore.mockResolvedValue({ status: 'rejected-before-dispatch', commandAttempted: false, reason: 'capability-unavailable' })
    for (let i = 0; i < 20; i++) {
      expect((await f.service.begin(1, 'library-record-id', assurance)).reason).toBe('sdk-preflight-rejected')
      expect(await f.service.hasUnresolvedOwnership()).toBe(false)
    }
    expect(await new DeviceRecordingRestoreService({ ...f.deps, processId: randomUUID() }).hasUnresolvedOwnership()).toBe(false)
    expect(readdirSync(f.journal.directory)).toHaveLength(40)
    expect(f.native.size).toBe(0)
  })
  it('retains 16 unknown BEGIN outcomes and explicitly reports memory capacity exhaustion', async () => {
    const f = fixture()
    f.device.applyRecordingRestore.mockRejectedValue(Error('Outcome unknown'))
    for (let i = 0; i < 16; i++) expect((await f.service.begin(1, 'library-record-id', assurance)).status).toBe('uncertain')
    expect((await f.service.begin(1, 'library-record-id', assurance)).reason).toBe('restore-session-capacity-exhausted')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(16)
    expect((await f.journal.list()).length).toBe(16)
    expect(await new DeviceRecordingRestoreService({ ...f.deps, processId: randomUUID() }).hasUnresolvedOwnership()).toBe(true)
  })
  it('leases release only after explicit accepted binding-validated ABORT/STATUS ABSENT and its durable receipt', async () => {
    const f = fixture(), first = await f.begin()
    expect((await f.service.abort(1, first, assurance)).reply?.stateCode).toBe(0)
    expect(await f.service.hasUnresolvedOwnership()).toBe(false)
    expect((await f.service.append(1, first, { offset: 0, count: 512 }, assurance)).status).toBe('rejected-before-dispatch')
    const id = await f.begin(), n = [...f.native.values()].at(-1)!
    n.state = 0; n.uploaded = 0; n.verified = 0
    const restarted = new DeviceRecordingRestoreService({ ...f.deps, processId: randomUUID() })
    expect(await restarted.hasUnresolvedOwnership()).toBe(true)
    const writes = f.device.applyRecordingRestore.mock.calls.length
    expect((await restarted.status(2, id)).reply?.stateCode).toBe(0)
    expect(await restarted.hasUnresolvedOwnership()).toBe(false)
    expect((await restarted.abort(2, id, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(writes)
  })
  it('does not release a short ABSENT hint, rejected ABSENT, or accepted ABSENT with nonzero progress', async () => {
    for (const cause of ['hint', 'rejected', 'progress'] as const) {
      const f = fixture(), id = await f.begin(), s = [...f.native.values()][0].descriptor
      const value = cause === 'hint' ? parseRecordingRestoreReply(s, { operation: 'status' }, new Uint8Array([1, 0, 0, 8]))! :
        reply(s, { operation: 'status' }, 0, cause === 'progress' ? 1 : 0, 0, cause === 'rejected' ? 8 : 0)
      f.device.getRecordingRestoreStatus.mockResolvedValueOnce(value)
      await f.service.status(1, id)
      expect(await f.service.hasUnresolvedOwnership()).toBe(true)
      expect(readdirSync(f.journal.directory)).toHaveLength(1)
    }
  })
  it('fails closed when encrypted resolution cannot be persisted, preserving ownership after verified readback', async () => {
    const f = fixture(), id = await f.begin(); await f.finish(id)
    vi.spyOn(f.journal, 'resolve').mockRejectedValueOnce(Error('fsync unavailable'))
    expect((await f.service.verifyReadback(1, id)).restoreVerified).toBe(false)
    expect(await f.service.hasUnresolvedOwnership()).toBe(true)
    expect(await new DeviceRecordingRestoreService({ ...f.deps, processId: randomUUID() }).hasUnresolvedOwnership()).toBe(true)
    expect((await f.service.verifyReadback(1, id)).restoreVerified).toBe(true)
    expect(await f.service.hasUnresolvedOwnership()).toBe(false)
  })
  it('fails closed on unknown files, partial ownership, corrupt receipts and unavailable encryption without native IO', async () => {
    for (const cause of ['unknown', 'partial', 'receipt', 'encryption'] as const) {
      const f = fixture(), id = await f.begin()
      if (cause === 'receipt') { await f.service.abort(1, id, assurance); writeFileSync(join(f.journal.directory, `${id}.rstr2.resolved.sealed`), Buffer.from('partial')) }
      if (cause === 'unknown') writeFileSync(join(f.journal.directory, 'unknown.sealed'), Buffer.from('unknown'))
      if (cause === 'partial') writeFileSync(join(f.journal.directory, `${id}.rstr2.sealed`), Buffer.alloc(0))
      if (cause === 'encryption') f.state.available = false
      const writes = f.device.applyRecordingRestore.mock.calls.length
      const restarted = new DeviceRecordingRestoreService({ ...f.deps, processId: randomUUID() })
      expect(await restarted.hasUnresolvedOwnership()).toBe(true)
      expect(f.device.getRecordingRestoreStatus).not.toHaveBeenCalled()
      expect(f.device.applyRecordingRestore).toHaveBeenCalledTimes(writes)
    }
  })
  it('can check ownership inside the device serializer without reacquiring it', async () => {
    const f = fixture()
    await expect(serializeDeviceOperation(() => f.service.hasUnresolvedOwnership())).resolves.toBe(false)
    await f.begin()
    await expect(serializeDeviceOperation(() => f.service.hasUnresolvedOwnership())).resolves.toBe(true)
  })
})
