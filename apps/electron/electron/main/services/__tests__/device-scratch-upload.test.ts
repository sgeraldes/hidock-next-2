/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DeviceScratchJournal } from '../device-scratch-journal'
import { parseOwnedScratchUploadReply, ownedScratchCrc32 } from '@hidock/jensen-protocol'
import type { CardInfo, DeviceInfo, OwnedScratchUploadOperation, OwnedScratchUploadReply, OwnedScratchUploadRequest, OwnedScratchUploadSession, OwnedScratchWriteOptions, OwnedScratchWriteOutcome } from '@hidock/jensen-protocol'
import { DeviceScratchUploadService } from '../device-scratch-upload'
import { serializeDeviceOperation } from '../device-operation-serializer'
import type { DeviceScratchWriteAssurance } from '../../../../src/shared/device-scratch-upload'

const assurance: DeviceScratchWriteAssurance = { ownedScratchWriteConsent: true, audioQuiescent: true }
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('hidock-scratch-upload-')) throw Error('Unsafe fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
function parsed(session: OwnedScratchUploadSession, request: OwnedScratchUploadRequest, state: 0 | 1 | 2 | 3 | 4 | 5, progress: number, rejected = false): OwnedScratchUploadReply {
  const body = new Uint8Array(6); body[0] = rejected ? 1 : 0; body[1] = state
  new DataView(body.buffer).setUint32(2, progress)
  const value = parseOwnedScratchUploadReply(session, request, body)
  if (!value) throw Error('Invalid test reply')
  return value
}
function fixture() {
  // Actual disk IO with modeled OS sealing; these tests do not exercise DPAPI.
  const directory = mkdtempSync(join(tmpdir(), 'hidock-scratch-upload-')); directories.push(directory)
  const key = randomBytes(32), crypto = { available: true }
  const sealed = {
    isEncryptionAvailable: () => crypto.available,
    encryptString: (text: string) => {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
    },
    decryptString: (bytes: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
  const hostJournal = new DeviceScratchJournal(directory, sealed)
  const state = { connected: true, idle: true, normal: true, mscInactive: true, epoch: 1 }
  const journals = new Map<number, { token: number; received: number; state: 1 | 2 | 3 | 4 | 5; step: number }>()
  const device = {
    serialNumber: 'PRIVATE-TEST-IDENTITY', versionNumber: 393986, versionCode: '6.3.2',
    getModel: () => 'hidock-h1e' as const, isConnected: () => state.connected, getConnectionSessionId: () => state.epoch,
    getDeviceInfo: vi.fn(async (): Promise<DeviceInfo | null> => ({ model: 'hidock-h1e', versionNumber: device.versionNumber, versionCode: device.versionCode, serialNumber: device.serialNumber })),
    getCardInfo: vi.fn(async (): Promise<CardInfo | null> => ({ capacity: 1024, free: 1000, used: 24, status: '900' })),
    createOwnedScratchUploadSession: vi.fn((uploadId: number, ownerToken: number, totalBytes: number, wholeCrc32: number): OwnedScratchUploadSession | null =>
      ({ uploadId, ownerToken, totalBytes, wholeCrc32, serialNumber: device.serialNumber, connectionSessionId: state.epoch, versionNumber: device.versionNumber as 393986 | 393988 })),
    applyOwnedScratchUpload: vi.fn(async (session: OwnedScratchUploadSession, request: OwnedScratchUploadOperation, _options: OwnedScratchWriteOptions): Promise<OwnedScratchWriteOutcome> => {
      let journal = journals.get(session.uploadId)
      if (request.operation === 'begin') { journal = { token: session.ownerToken, received: 0, state: 1, step: 0 }; journals.set(session.uploadId, journal) }
      if (!journal || journal.token !== session.ownerToken) return { status: 'rejected-before-dispatch', commandAttempted: false, reason: 'not-owned' }
      if (request.operation === 'abort') { journals.delete(session.uploadId); return { status: 'reply', commandAttempted: true, reply: parsed(session, request, 0, 0) } }
      if (request.operation === 'append') journal.received += request.data.length
      let progress = journal.received
      if (request.operation === 'commit') {
        journal.state = ([2, 3, 5, 4] as const)[Math.min(journal.step++, 3)]
        progress = journal.state === 2 || journal.state === 5 ? Math.min(512, session.totalBytes) : session.totalBytes
      }
      return { status: 'reply', commandAttempted: true, reply: parsed(session, request, journal.state, progress) }
    }),
    getOwnedScratchUploadStatus: vi.fn(async (session: OwnedScratchUploadSession): Promise<OwnedScratchUploadReply | null> => {
      const journal = journals.get(session.uploadId)
      return !journal || journal.token !== session.ownerToken ? null : parsed(session, { operation: 'status' }, journal.state,
        journal.state === 2 || journal.state === 5 ? Math.min(512, session.totalBytes) : journal.received)
    })
  }
  const deps = { device: () => device, serialize: serializeDeviceOperation, idle: () => state.idle, normalJensen: () => state.normal, massStorageInactive: () => state.mscInactive, journal: hostJournal }
  const service = new DeviceScratchUploadService(deps)
  const begin = async (totalBytes = 1025) => {
    const result = await service.begin(1, { totalBytes, wholeCrc32: ownedScratchCrc32(new Uint8Array(totalBytes)) }, assurance)
    expect(result.status).toBe('reply'); expect(result.sessionId).toBeTypeOf('string')
    return result.sessionId!
  }
  return { state, device, journals, deps, service, begin, directory, hostJournal, crypto, sealed }
}

describe('owned scratch app orchestrator: one bounded owner operation per invocation', () => {
  it.each([[393986, '6.3.2'], [393988, '6.3.4']] as const)('seals the actual exact firmware identity%s/%s and permits explicit same-version epoch rebind', async (version, code) => {
    const f = fixture(); f.device.versionNumber = version; f.device.versionCode = code
    const id = await f.begin(512), ciphertext = readFileSync(join(f.directory, `${id}.sealed`))
    expect((await f.hostJournal.load(id)).session.versionNumber).toBe(version)
    const original = (await f.hostJournal.load(id)).session
    f.state.epoch++
    const restarted = new DeviceScratchUploadService(f.deps)
    expect(await restarted.status(2, id)).toMatchObject({ status: 'reply', reply: { stateCode: 1, progressBytes: 0 } })
    expect(f.device.getOwnedScratchUploadStatus).toHaveBeenLastCalledWith(expect.objectContaining({ versionNumber: version, connectionSessionId: f.state.epoch }), 5, undefined)
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(f.directory, `${id}.sealed`))).toEqual(ciphertext)
    expect((await f.hostJournal.load(id)).session).toEqual(original)
  })
  it.each([[393986, '6.3.2', 393988, '6.3.4'], [393988, '6.3.4', 393986, '6.3.2']] as const)('does not migrate sealed%s ownership to supported%s firmware', async (version, code, nextVersion, nextCode) => {
    const f = fixture(); f.device.versionNumber = version; f.device.versionCode = code
    const id = await f.begin(512), ciphertext = readFileSync(join(f.directory, `${id}.sealed`))
    f.device.versionNumber = nextVersion; f.device.versionCode = nextCode; f.state.epoch++
    expect(await f.service.status(1, id)).toMatchObject({ status: 'status-unavailable', reason: 'historical-firmware-binding-mismatch' })
    const restarted = new DeviceScratchUploadService(f.deps)
    expect(await restarted.status(2, id)).toMatchObject({ status: 'status-unavailable', reason: 'historical-firmware-binding-mismatch' })
    expect(f.device.getOwnedScratchUploadStatus).not.toHaveBeenCalled()
    expect(await f.service.abort(1, id, assurance)).toMatchObject({ status: 'rejected-before-dispatch', commandAttempted: false })
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
    expect(f.device.createOwnedScratchUploadSession).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(f.directory, `${id}.sealed`))).toEqual(ciphertext)
  })
  it.each([[393988, '6.3.2'], [393986, '6.3.4'], [393989, '6.3.5']] as const)('rejects unqualified or incoherent%s/%s before identity queries or mutation', async (version, code) => {
    const f = fixture(); f.device.versionNumber = version; f.device.versionCode = code
    expect(await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)).toMatchObject({ status: 'rejected-before-dispatch', reason: 'owner-unavailable' })
    expect(f.device.getDeviceInfo).not.toHaveBeenCalled(); expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
    expect(readdirSync(f.directory)).toEqual([])
  })
  it('rejects switching between qualified versions during fresh BEGIN identity reads', async () => {
    const f = fixture(), get = f.device.getDeviceInfo.getMockImplementation()!
    f.device.getDeviceInfo.mockImplementationOnce(async () => {
      const info = await get(); f.device.versionNumber = 393988; f.device.versionCode = '6.3.4'; return info
    })
    expect(await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)).toMatchObject({ status: 'rejected-before-dispatch', reason: 'fresh-identity-unavailable' })
    expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled(); expect(readdirSync(f.directory)).toEqual([])
  })
  it('discards a STATUS reply if firmware switches between qualified versions within the same epoch', async () => {
    const f = fixture(), id = await f.begin(512), status = f.device.getOwnedScratchUploadStatus.getMockImplementation()!
    f.device.getOwnedScratchUploadStatus.mockImplementationOnce(async (...args) => {
      const reply = await status(...args); f.device.versionNumber = 393988; f.device.versionCode = '6.3.4'; return reply
    })
    expect(await f.service.status(1, id)).toMatchObject({ status: 'status-unavailable', reason: 'status-unconfirmed', finished: false })
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
  })
  it('reads a durable sealed descriptor at the native BEGIN boundary, with no plaintext record', async () => {
    const f = fixture(), backend = f.device.applyOwnedScratchUpload.getMockImplementation()!
    f.device.applyOwnedScratchUpload.mockImplementationOnce(async (...args) => {
      const files = readdirSync(f.directory)
      expect(files).toHaveLength(1)
      const ciphertext = readFileSync(join(f.directory, files[0]))
      expect(ciphertext.includes(Buffer.from(f.device.serialNumber))).toBe(false)
      const record = await f.hostJournal.load(files[0].slice(0, -7))
      expect(record.session).toEqual(args[0])
      return backend(...args)
    })
    await f.begin(512)
  })
  it('fails before mutation when encryption is missing or durability fails', async () => {
    const f = fixture(); f.crypto.available = false
    expect((await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)).reason).toBe('host-encryption-unavailable')
    expect(f.device.getDeviceInfo).not.toHaveBeenCalled()
    f.crypto.available = true
    vi.spyOn(f.hostJournal, 'create').mockRejectedValueOnce(Error('private filesystem path'))
    const result = await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)
    expect(result.reason).toBe('sealed-ownership-not-durable')
    expect(JSON.stringify(result)).not.toContain('private filesystem path')
    expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
  })
  it('rechecks encryption and owner after durable storage before native BEGIN', async () => {
    for (const cause of ['encryption', 'owner'] as const) {
      const f = fixture(); let ownerAvailable = true
      const service = new DeviceScratchUploadService({ ...f.deps, ownerAvailable: () => ownerAvailable })
      const create = f.hostJournal.create.bind(f.hostJournal)
      vi.spyOn(f.hostJournal, 'create').mockImplementationOnce(async (...args) => {
        const record = await create(...args)
        if (cause === 'encryption') f.crypto.available = false
        else ownerAvailable = false
        return record
      })
      const result = await service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)
      expect(result.status).toBe('rejected-before-dispatch')
      expect(result.reason).toBe(cause === 'encryption' ? 'pre-dispatch-resolution-unavailable' : 'application-owner-unavailable')
      expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
      expect(readdirSync(f.directory)).toHaveLength(cause === 'encryption' ? 1 : 2)
      expect(await service.hasUnresolvedOwnership()).toBe(cause === 'encryption')
    }
  })
  it('retains uncertain BEGIN ownership across restart and rebinds without any automatic write', async () => {
    const f = fixture(), backend = f.device.applyOwnedScratchUpload.getMockImplementation()!
    f.device.applyOwnedScratchUpload.mockImplementationOnce(async (...args) => { await backend(...args); return { status: 'uncertain', commandAttempted: true, reason: 'lost-ack' } })
    const result = await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance), id = result.sessionId!
    expect(result.status).toBe('uncertain')
    f.state.epoch++
    const restarted = new DeviceScratchUploadService(f.deps)
    expect(f.device.getOwnedScratchUploadStatus).not.toHaveBeenCalled()
    expect((await restarted.abort(1, id, assurance)).status).toBe('rejected-before-dispatch')
    expect((await restarted.status(1, id)).reply?.stateCode).toBe(1)
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
    expect((await restarted.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)).status).toBe('reply')
    expect(readdirSync(f.directory)).toHaveLength(1)
  })
  it('does not promote recovered metadata with a wrong serial, rejected ACK or missing native ownership', async () => {
    const f = fixture(), id = await f.begin(512), session = f.device.createOwnedScratchUploadSession.mock.results[0].value!
    const restarted = new DeviceScratchUploadService(f.deps)
    f.device.serialNumber = 'OTHER'
    expect((await restarted.status(1, id)).reason).toBe('original-device-not-corroborated')
    expect(f.device.getOwnedScratchUploadStatus).not.toHaveBeenCalled()
    f.device.serialNumber = 'PRIVATE-TEST-IDENTITY'
    f.device.getOwnedScratchUploadStatus.mockResolvedValueOnce(parsed(session, { operation: 'status' }, 1, 0, true))
    expect((await restarted.status(1, id)).reply?.acknowledgement).toBe('rejected')
    expect((await restarted.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)).status).toBe('rejected-before-dispatch')
    f.device.getOwnedScratchUploadStatus.mockResolvedValueOnce(null)
    expect((await restarted.status(1, id)).status).toBe('status-unavailable')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
    expect(readdirSync(f.directory)).toHaveLength(1)
  })
  it('canonicalizes UUID ownership and checks competing restart claims inside the serializer', async () => {
    const f = fixture(), id = await f.begin(512)
    expect((await f.service.status(2, id.toUpperCase())).status).toBe('rejected-before-dispatch')
    const restarted = new DeviceScratchUploadService(f.deps)
    const replies = await Promise.all([restarted.status(1, id), restarted.status(2, id.toUpperCase())])
    expect(replies.map(reply => reply.status)).toEqual(['reply', 'rejected-before-dispatch'])
    expect(f.device.getOwnedScratchUploadStatus).toHaveBeenCalledTimes(1)
  })
  it('evicts only confirmed finished process entries and preserves their durable record and file', async () => {
    const f = fixture(), ids: string[] = []
    for (let i = 0; i < 18; i++) {
      const id = await f.begin(1); ids.push(id)
      await f.service.append(1, id, { offset: 0, data: new Uint8Array(1) }, assurance)
      for (let step = 0; step < 4; step++) await f.service.commit(1, id, assurance)
    }
    expect(readdirSync(f.directory)).toHaveLength(36)
    expect(await f.service.hasUnresolvedOwnership()).toBe(false)
    const writes = f.device.applyOwnedScratchUpload.mock.calls.length
    expect((await f.service.status(1, ids[0])).finished).toBe(true)
    expect((await f.service.abort(1, ids[0], assurance)).reason).toBe('finished-file-preserved')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(writes)
    expect(f.journals.size).toBe(18)
  })
  it('generates private identity, checks fresh card reserve, accepts exact tail and commits only upon manual calls', async () => {
    const f = fixture(), id = await f.begin()
    const session = f.device.createOwnedScratchUploadSession.mock.results[0].value!
    expect(session.uploadId).toBeGreaterThan(0); expect(session.ownerToken).toBeGreaterThan(0)
    const status = await f.service.status(1, id)
    expect(status.filename).toMatch(/^REA[A-F0-9]{8}\.hda$/)
    expect(JSON.stringify(status)).not.toContain('PRIVATE-TEST-IDENTITY')
    expect(status).not.toHaveProperty('ownerToken'); expect(status).not.toHaveProperty('uploadId')
    await f.service.append(1, id, { offset: 0, data: new Uint8Array(1024) }, assurance)
    await f.service.append(1, id, { offset: 1024, data: new Uint8Array(1) }, assurance)
    for (const state of [2, 3, 5, 4]) {
      const previous = f.device.applyOwnedScratchUpload.mock.calls.length
      const result = await f.service.commit(1, id, assurance)
      expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(previous + 1)
      expect(result.reply?.stateCode).toBe(state); expect(result.finished).toBe(state === 4)
      expect(result.reply?.persistence).toBe('unverified'); expect(result.reply?.imageAttested).toBe(false)
    }
    const writes = f.device.applyOwnedScratchUpload.mock.calls.length
    expect((await f.service.abort(1, id, assurance)).reason).toBe('finished-file-preserved')
    expect((await f.service.commit(1, id, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(writes)
    expect(f.device.applyOwnedScratchUpload.mock.calls.every(call => call[2].ownedScratchWriteConsent && call[2].audioQuiescent && call[2].normalJensen && call[2].massStorageInactive)).toBe(true)
  })

  it.each([0, -1, 0x800000, NaN, 1.5])('rejects total bound %s without device dispatch', async totalBytes => {
    const f = fixture()
    expect((await f.service.begin(1, { totalBytes, wholeCrc32: 1 }, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.getDeviceInfo).not.toHaveBeenCalled(); expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
  })
  it('rejects a caller path/name, invalid CRC and missing explicit consent/audio assertion', async () => {
    const f = fixture()
    for (const descriptor of [{ totalBytes: 512, wholeCrc32: -1 }, { totalBytes: 512, wholeCrc32: 1, filename: 'foreign.hda' }, { totalBytes: 512, wholeCrc32: 1, path: 'C:/arbitrary' }]) {
      expect((await f.service.begin(1, descriptor, assurance)).status).toBe('rejected-before-dispatch')
    }
    for (const permission of [{}, { ownedScratchWriteConsent: true }, { audioQuiescent: true }, { ...assurance, normalJensen: true }]) {
      expect((await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, permission as DeviceScratchWriteAssurance)).status).toBe('rejected-before-dispatch')
    }
    expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
  })
  it.each(['idle', 'normal', 'mscInactive', 'connected'] as const)('fails closed on missing main corroboration: %s', async key => {
    const f = fixture(); f.state[key] = false
    expect((await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
  })
  it('requires exact custom family/version and fresh identity after card reads', async () => {
    const f = fixture(); f.device.versionNumber = 393985
    expect((await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)).status).toBe('rejected-before-dispatch')
    f.device.versionNumber = 393986
    f.device.getCardInfo.mockImplementationOnce(async () => { f.state.epoch++; return { capacity: 1024, free: 1000, used: 24, status: '900' } })
    expect((await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)).reason).toBe('fresh-identity-unavailable')
    expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
  })
  it.each([
    { capacity: 1024, free: 8, used: 1016, status: '900' },
    { capacity: 1024, free: 1000, used: 1, status: '900' },
    { capacity: 1024, free: 1000.5, used: 23.5, status: '900' },
    { capacity: 1024, free: 1000, used: 24, status: '100' },
    { capacity: 1024, free: 1000, used: 24, status: 'unknown' }
  ])('rejects insufficient or malformed card info %#', async card => {
    const f = fixture(); f.device.getCardInfo.mockResolvedValueOnce(card)
    expect((await f.service.begin(1, { totalBytes: 1, wholeCrc32: 1 }, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
  })
  it('includes worst-case journal plus eight MiB reserve at the upper file bound', async () => {
    const f = fixture()
    f.device.getCardInfo.mockResolvedValueOnce({ capacity: 1024, free: 16, used: 1008, status: '940' })
    expect((await f.service.begin(1, { totalBytes: 0x7fffff, wholeCrc32: 1 }, assurance)).reason).toBe('scratch-space-or-card-unavailable')
    f.device.getCardInfo.mockResolvedValueOnce({ capacity: 1024, free: 17, used: 1007, status: '940' })
    expect((await f.service.begin(1, { totalBytes: 0x7fffff, wholeCrc32: 1 }, assurance)).status).toBe('reply')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
  })
  it('bounds append sizes, rejects gaps and requires complete upload before commits', async () => {
    const f = fixture(), id = await f.begin(2048)
    for (const request of [{ offset: 0, data: new Uint8Array() }, { offset: 0, data: new Uint8Array(511) }, { offset: 0, data: new Uint8Array(1025) }, { offset: -1, data: new Uint8Array(512) }, { offset: 512, data: new Uint8Array(512) }]) {
      expect((await f.service.append(1, id, request, assurance)).status).toBe('rejected-before-dispatch')
    }
    expect((await f.service.commit(1, id, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
  })
  it('copies queued descriptor and append bytes before caller mutation, using the actual shared serializer', async () => {
    const f = fixture(), id = await f.begin(512)
    let release!: () => void
    const preceding = serializeDeviceOperation(() => new Promise<void>(resolve => { release = resolve }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const data = new Uint8Array(512).fill(0x31)
    const append = f.service.append(1, id, { offset: 0, data }, assurance)
    data.fill(0xff)
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
    release(); await preceding; await append
    expect((f.device.applyOwnedScratchUpload.mock.calls[1][1] as { data: Uint8Array }).data).toEqual(new Uint8Array(512).fill(0x31))
  })
  it('serializes competing same-offset appends without replaying the second write', async () => {
    const f = fixture(), id = await f.begin(1024)
    const results = await Promise.all([f.service.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance), f.service.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)])
    expect(results.map(value => value.status)).toEqual(['reply', 'rejected-before-dispatch'])
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(2)
  })
  it('requires per-call consent and exact owner without aborting or deleting on a window change', async () => {
    const f = fixture(), id = await f.begin(512)
    expect((await f.service.append(2, id, { offset: 0, data: new Uint8Array(512) }, assurance)).status).toBe('rejected-before-dispatch')
    expect((await f.service.abort(2, id, assurance)).status).toBe('rejected-before-dispatch')
    expect((await f.service.status(2, id)).status).toBe('rejected-before-dispatch')
    expect((await f.service.abort(1, id, {} as DeviceScratchWriteAssurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
    expect((await f.service.abort(1, id, assurance)).reply?.stateCode).toBe(0)
  })
  it('keeps uncertain mutations fenced until an explicit accepted owned STATUS, with no automatic retry', async () => {
    const f = fixture(), id = await f.begin(512)
    const backend = f.device.applyOwnedScratchUpload.getMockImplementation()!
    f.device.applyOwnedScratchUpload.mockImplementationOnce(async (...args) => { await backend(...args); return { status: 'uncertain', commandAttempted: true, reason: 'missing-ack' } })
    expect((await f.service.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)).status).toBe('uncertain')
    const previous = f.device.applyOwnedScratchUpload.mock.calls.length
    expect((await f.service.commit(1, id, assurance)).status).toBe('rejected-before-dispatch')
    expect((await f.service.abort(1, id, assurance)).reason).toBe('explicit-status-required-after-uncertainty')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(previous)
    expect((await f.service.status(1, id)).reply?.progressBytes).toBe(512)
    expect((await f.service.commit(1, id, assurance)).reply?.stateCode).toBe(2)
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(previous + 1)
  })
  it('rebinding after reconnect requires an explicit read-only status from the same fresh serial', async () => {
    const f = fixture(), id = await f.begin(512), original = f.device.createOwnedScratchUploadSession.mock.results[0].value!
    f.state.epoch++
    expect((await f.service.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)).status).toBe('rejected-before-dispatch')
    const writes = f.device.applyOwnedScratchUpload.mock.calls.length
    expect((await f.service.status(1, id)).status).toBe('reply')
    const rebound = f.device.createOwnedScratchUploadSession.mock.results[1].value!
    expect(rebound).toMatchObject({ uploadId: original.uploadId, ownerToken: original.ownerToken, wholeCrc32: original.wholeCrc32, totalBytes: 512, connectionSessionId: 2 })
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(writes)
    expect((await f.service.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)).status).toBe('reply')
  })
  it('never rebinds to a replacement serial or unconfirmed ownership response', async () => {
    const f = fixture(), id = await f.begin(512)
    f.state.epoch++; f.device.serialNumber = 'OTHER-DEVICE'
    expect((await f.service.status(1, id)).reason).toBe('original-device-not-corroborated')
    expect(f.device.getOwnedScratchUploadStatus).not.toHaveBeenCalled()
    f.device.serialNumber = 'PRIVATE-TEST-IDENTITY'; f.device.getOwnedScratchUploadStatus.mockResolvedValueOnce(null)
    expect((await f.service.status(1, id)).status).toBe('status-unavailable')
    expect((await f.service.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
  })
  it('marks post-dispatch cancellation and unexpected backend exceptions uncertain, exposing no raw details', async () => {
    const f = fixture(), id = await f.begin(512), controller = new AbortController()
    const backend = f.device.applyOwnedScratchUpload.getMockImplementation()!
    f.device.applyOwnedScratchUpload.mockImplementationOnce(async (...args) => { const result = await backend(...args); controller.abort(); return result })
    const cancelled = await f.service.append(1, id, { offset: 0, data: new Uint8Array(512) }, { ...assurance, signal: controller.signal })
    expect(cancelled).toMatchObject({ status: 'uncertain', commandAttempted: true, finished: false })
    await f.service.status(1, id)
    f.device.applyOwnedScratchUpload.mockRejectedValueOnce(new Error('PRIVATE-TOKEN secret transport details'))
    const failed = await f.service.commit(1, id, assurance)
    expect(failed).toMatchObject({ status: 'uncertain', commandAttempted: null, finished: false })
    expect(JSON.stringify(failed)).not.toContain('PRIVATE-TOKEN')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(3)
  })
  it('does not claim finished for rejected ACK, malformed progress or changed epoch during dispatch', async () => {
    const f = fixture(), id = await f.begin(512), session = f.device.createOwnedScratchUploadSession.mock.results[0].value!
    await f.service.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)
    f.device.applyOwnedScratchUpload.mockResolvedValueOnce({ status: 'reply', commandAttempted: true, reply: parsed(session, { operation: 'commit' }, 4, 512, true) })
    expect((await f.service.commit(1, id, assurance)).finished).toBe(false)
    await f.service.status(1, id)
    const invalid = { ...parsed(session, { operation: 'commit' }, 4, 512), progressBytes: 511 }
    f.device.applyOwnedScratchUpload.mockResolvedValueOnce({ status: 'reply', commandAttempted: true, reply: invalid })
    expect((await f.service.commit(1, id, assurance)).status).toBe('uncertain')
    await f.service.status(1, id)
    const backend = f.device.applyOwnedScratchUpload.getMockImplementation()!
    f.device.applyOwnedScratchUpload.mockImplementationOnce(async (...args) => { const result = await backend(...args); f.state.epoch++; return result })
    expect((await f.service.commit(1, id, assurance)).status).toBe('uncertain')
  })
  it('preserves independent SDK read-only rejection and makes no implicit write during STATUS', async () => {
    const f = fixture()
    f.device.applyOwnedScratchUpload.mockResolvedValueOnce({ status: 'rejected-before-dispatch', commandAttempted: false, reason: 'read-only-policy' })
    const result = await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)
    expect(result.status).toBe('rejected-before-dispatch')
    const writes = f.device.applyOwnedScratchUpload.mock.calls.length
    await f.service.status(1, result.sessionId!)
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(writes)
  })
  it('bounds active private sessions and recovers only through explicit accepted STATUS after recreation', async () => {
    const f = fixture(), ids: string[] = []
    for (let n = 0; n < 16; n++) ids.push(await f.begin(1))
    expect((await f.service.begin(1, { totalBytes: 1, wholeCrc32: 1 }, assurance)).reason).toBe('process-session-capacity-reached')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(16)
    const restarted = new DeviceScratchUploadService(f.deps)
    expect((await restarted.append(1, ids[0], { offset: 0, data: new Uint8Array(1) }, assurance)).status).toBe('rejected-before-dispatch')
    expect((await restarted.status(1, ids[0])).status).toBe('reply')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(16)
  })
  it('enumerates durable restart ownership read-only and resolves old FINISHED only by explicit accepted STATUS', async () => {
    const f = fixture(), id = await f.begin(512), n = [...f.journals.values()][0]
    n.state = 4; n.received = 512 // Historical physically completed fixture, not yet observed by this host.
    f.state.epoch++
    const restarted = new DeviceScratchUploadService(f.deps), writes = f.device.applyOwnedScratchUpload.mock.calls.length
    expect(await restarted.hasUnresolvedOwnership()).toBe(true)
    expect(f.device.getOwnedScratchUploadStatus).not.toHaveBeenCalled()
    expect((await restarted.status(2, id)).finished).toBe(true)
    expect(await restarted.hasUnresolvedOwnership()).toBe(false)
    expect(await new DeviceScratchUploadService(f.deps).hasUnresolvedOwnership()).toBe(false)
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(writes)
    expect(readdirSync(f.directory)).toHaveLength(2)
    expect((await f.hostJournal.load(id)).session.connectionSessionId).toBe(1)
  })
  it('retains mismatched historical firmware and rejected ambiguous ABSENT/FINISHED across restart', async () => {
    for (const cause of ['version', 'absent', 'finished'] as const) {
      const f = fixture(), id = await f.begin(512), bound = f.device.createOwnedScratchUploadSession.mock.results[0].value!
      const restarted = new DeviceScratchUploadService(f.deps)
      if (cause === 'version') { f.device.versionNumber = 393988; f.device.versionCode = '6.3.4' }
      else f.device.getOwnedScratchUploadStatus.mockResolvedValueOnce(parsed(bound, { operation: 'status' }, cause === 'absent' ? 0 : 4, cause === 'absent' ? 0 : 512, true))
      await restarted.status(2, id)
      expect(await restarted.hasUnresolvedOwnership()).toBe(true)
      expect(readdirSync(f.directory)).toHaveLength(1)
      expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
    }
  })
  it('does not exhaust process leases after definitely non-dispatched BEGINs, preserving every immutable record', async () => {
    const f = fixture()
    f.device.applyOwnedScratchUpload.mockResolvedValue({ status: 'rejected-before-dispatch', commandAttempted: false, reason: 'unavailable' })
    for (let i = 0; i < 20; i++) {
      expect((await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)).reason).toBe('sdk-preflight-rejected')
      expect(await f.service.hasUnresolvedOwnership()).toBe(false)
    }
    expect(readdirSync(f.directory)).toHaveLength(40)
    expect(await new DeviceScratchUploadService(f.deps).hasUnresolvedOwnership()).toBe(false)
    expect(f.journals.size).toBe(0)
  })
  it('keeps unknown dispatches durable and releases one lease only after explicit native ABORT', async () => {
    const f = fixture(), backend = f.device.applyOwnedScratchUpload.getMockImplementation()!
    f.device.applyOwnedScratchUpload.mockImplementationOnce(async (...args) => { await backend(...args); throw Error('lost backend outcome') })
    const result = await f.service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance), id = result.sessionId!
    expect(result.status).toBe('uncertain')
    expect(await new DeviceScratchUploadService(f.deps).hasUnresolvedOwnership()).toBe(true)
    expect((await f.service.abort(1, id, assurance)).reason).toBe('explicit-status-required-after-uncertainty')
    await f.service.status(1, id)
    expect((await f.service.abort(1, id, assurance)).reply?.stateCode).toBe(0)
    expect(await f.service.hasUnresolvedOwnership()).toBe(false)
    expect(await new DeviceScratchUploadService(f.deps).hasUnresolvedOwnership()).toBe(false)
    expect(readdirSync(f.directory)).toHaveLength(2)
  })
  it('does not declare resolved ownership when receipt durability fails after exact FINISHED', async () => {
    const f = fixture(), id = await f.begin(512), n = [...f.journals.values()][0]
    n.state = 4; n.received = 512
    vi.spyOn(f.hostJournal, 'resolve').mockRejectedValueOnce(Error('fsync failure'))
    expect((await f.service.status(1, id)).status).toBe('status-unavailable')
    expect(await f.service.hasUnresolvedOwnership()).toBe(true)
    expect(await new DeviceScratchUploadService(f.deps).hasUnresolvedOwnership()).toBe(true)
    expect((await f.service.status(1, id)).finished).toBe(true)
    expect(await f.service.hasUnresolvedOwnership()).toBe(false)
  })
  it('fails closed on corrupt authorities, receipts and unknown entries without any native IO', async () => {
    for (const cause of ['authority', 'receipt', 'unknown'] as const) {
      const f = fixture(), id = await f.begin(512)
      if (cause === 'receipt') { await f.service.abort(1, id, assurance); writeFileSync(join(f.directory, `${id}.resolved.sealed`), 'crash') }
      if (cause === 'authority') writeFileSync(join(f.directory, `${id}.sealed`), '')
      if (cause === 'unknown') writeFileSync(join(f.directory, 'unknown.entry'), 'unknown')
      const writes = f.device.applyOwnedScratchUpload.mock.calls.length
      expect(await new DeviceScratchUploadService(f.deps).hasUnresolvedOwnership()).toBe(true)
      expect(f.device.getOwnedScratchUploadStatus).not.toHaveBeenCalled()
      expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(writes)
    }
  })
  it('allows ownership checks inside the shared serializer without acquiring it again', async () => {
    const f = fixture()
    await expect(serializeDeviceOperation(() => f.service.hasUnresolvedOwnership())).resolves.toBe(false)
    await f.begin(512)
    await expect(serializeDeviceOperation(() => f.service.hasUnresolvedOwnership())).resolves.toBe(true)
  })

  it.each(['destroyed', 'navigated'] as const)('rechecks a %s owner after queued BEGIN reaches the actual serializer slot', async cause => {
    const f = fixture(), owner = { destroyed: false, navigated: false }
    const service = new DeviceScratchUploadService({ ...f.deps, ownerAvailable: ownerId => ownerId === 1 && !owner.destroyed && !owner.navigated })
    let release!: () => void
    const preceding = serializeDeviceOperation(() => new Promise<void>(resolve => { release = resolve }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const queued = service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)
    owner[cause] = true
    release(); await preceding
    expect(await queued).toMatchObject({ status: 'rejected-before-dispatch', commandAttempted: false, reason: 'application-owner-unavailable' })
    expect(f.device.getDeviceInfo).not.toHaveBeenCalled()
    expect(f.device.getCardInfo).not.toHaveBeenCalled()
    expect(f.device.createOwnedScratchUploadSession).not.toHaveBeenCalled()
    expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
  })

  it.each(['destroyed', 'navigated'] as const)('rejects a queued append from a %s owner without implicit abort/deletion of its owned file', async cause => {
    const f = fixture(), owner = { destroyed: false, navigated: false }
    const service = new DeviceScratchUploadService({ ...f.deps, ownerAvailable: ownerId => ownerId === 1 && !owner.destroyed && !owner.navigated })
    const initial = await service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)
    const id = initial.sessionId!
    const journal = [...f.journals.values()][0]
    let release!: () => void
    const preceding = serializeDeviceOperation(() => new Promise<void>(resolve => { release = resolve }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const queued = service.append(1, id, { offset: 0, data: new Uint8Array(512) }, assurance)
    owner[cause] = true
    release(); await preceding
    expect(await queued).toMatchObject({ status: 'rejected-before-dispatch', commandAttempted: false, reason: 'application-owner-unavailable' })
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1) // Only the earlier explicit BEGIN.
    expect(f.journals.size).toBe(1)
    expect([...f.journals.values()][0]).toBe(journal)
    expect(journal.received).toBe(0)
    expect((await service.abort(1, id, assurance)).status).toBe('rejected-before-dispatch')
    expect(f.device.applyOwnedScratchUpload).toHaveBeenCalledTimes(1)
  })

  it('rejects BEGIN if its owner disappears during the fresh card-readiness await', async () => {
    const f = fixture()
    let available = true
    const service = new DeviceScratchUploadService({ ...f.deps, ownerAvailable: ownerId => ownerId === 1 && available })
    let release!: (card: CardInfo) => void
    f.device.getCardInfo.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const begin = service.begin(1, { totalBytes: 512, wholeCrc32: 1 }, assurance)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    available = false
    release({ capacity: 1024, free: 1000, used: 24, status: '900' })
    expect(await begin).toMatchObject({ status: 'rejected-before-dispatch', commandAttempted: false, reason: 'application-owner-unavailable' })
    expect(f.device.applyOwnedScratchUpload).not.toHaveBeenCalled()
    expect(f.journals.size).toBe(0)
  })
})
