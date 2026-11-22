/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DeviceRecordingRestoreJournal, RESTORE_JOURNAL_MAX_OWNERSHIP } from '../device-recording-restore-journal'
import type { RecordingRestoreOwnershipRecord } from '../device-recording-restore-journal'
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('hidock-restore-journal-')) throw Error('Unsafe cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hidock-restore-journal-')); directories.push(directory)
  const key = randomBytes(32), available = { value: true }, sealed = {
    isEncryptionAvailable: () => available.value,
    encryptString: (text: string) => { const nonce = randomBytes(12), c = createCipheriv('aes-256-gcm', key, nonce), bytes = Buffer.concat([c.update(text), c.final()]); return Buffer.concat([nonce, c.getAuthTag(), bytes]) },
    decryptString: (bytes: Buffer) => { const c = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString('utf8') }
  }
  const record: RecordingRestoreOwnershipRecord = { schema: 'RSTR2', id: randomUUID(), processId: randomUUID(), createdAt: new Date().toISOString(), ownerId: 1, recordingId: 'trusted-library-id',
    source: { path: join(directory, 'private-source.bin'), filename: 'original.wav', size: 0, dev: '1', ino: '2', mtimeNs: '123', ctimeNs: '124' },
    session: { restoreId: 23, ownerToken: Uint8Array.from(randomBytes(16)), totalBytes: 0, wholeCrc32: 0, sourceSha256: Uint8Array.from(createHash('sha256').update('').digest()), filename: 'original.wav', serialNumber: 'PRIVATE-SERIAL', connectionSessionId: 5, versionNumber: 393988 } }
  const journal = new DeviceRecordingRestoreJournal(directory, sealed), path = join(directory, `${record.id}.rstr2.sealed`)
  return { directory, sealed, record, journal, path, available }
}
describe('RSTR2 immutable OS-facade-sealed journal on real filesystem, modeled crypto', () => {
  it('round trips strict token/SHA byte arrays through a fresh journal without plaintext and refuses replacement', async () => {
    const f = fixture(); await f.journal.create(f.record)
    const bytes = readFileSync(f.path)
    expect(bytes.includes(Buffer.from('PRIVATE-SERIAL'))).toBe(false)
    expect(bytes.includes(Buffer.from(f.record.source.path))).toBe(false)
    const loaded = await new DeviceRecordingRestoreJournal(f.directory, f.sealed).load(f.record.id.toUpperCase())
    expect(loaded).toEqual(f.record); expect(loaded.session.ownerToken).toBeInstanceOf(Uint8Array)
    await expect(f.journal.create(f.record)).rejects.toThrow(); expect(readFileSync(f.path)).toEqual(bytes)
    expect(readdirSync(f.directory)).toEqual([`${f.record.id}.rstr2.sealed`])
  })
  it('refuses unavailable crypto and never uses plaintext fallback', async () => {
    const f = fixture(); f.available.value = false
    await expect(f.journal.create(f.record)).rejects.toThrow('unavailable')
    await expect(f.journal.load(f.record.id)).rejects.toThrow('unavailable')
    expect(readdirSync(f.directory)).toEqual([])
  })
  it('snapshots mutable ownership metadata before asynchronous filesystem work', async () => {
    const f = fixture(), expected = { ...f.record, session: { ...f.record.session, ownerToken: f.record.session.ownerToken.slice() }, source: { ...f.record.source } }
    const pending = f.journal.create(f.record)
    f.record.session.ownerToken[0] ^= 0xff; f.record.source.ctimeNs = '999'
    await pending
    expect(await f.journal.load(f.record.id)).toEqual(expected)
  })
  it('rejects new ownership at its real filesystem capacity while reserving a durable resolution slot', async () => {
    const f = fixture()
    for (let i = 0; i < RESTORE_JOURNAL_MAX_OWNERSHIP; i++) {
      const record = { ...f.record, id: i === 0 ? f.record.id : randomUUID() }
      writeFileSync(join(f.directory, `${record.id}.rstr2.sealed`), f.sealed.encryptString(JSON.stringify({ ...record,
        session: { ...record.session, ownerToken: Buffer.from(record.session.ownerToken).toString('hex'), sourceSha256: Buffer.from(record.session.sourceSha256).toString('hex') } })))
    }
    await expect(f.journal.create({ ...f.record, id: randomUUID() })).rejects.toThrow('capacity exhausted')
    expect(await f.journal.remainingAuthorityCapacity()).toBe(0)
    await f.journal.resolve(f.record, { kind: 'begin-not-dispatched' })
    expect(await f.journal.isResolved(f.record.id)).toBe(true)
    expect(await f.journal.remainingAuthorityCapacity()).toBe(0) // Receipt does not retire immutable authority.
    expect(readdirSync(f.directory)).toHaveLength(RESTORE_JOURNAL_MAX_OWNERSHIP + 1)
  })
  it('reports a validated planning snapshot that can fit all558 protected baseline recordings', async () => {
    const f = fixture()
    expect(await f.journal.remainingAuthorityCapacity()).toBe(1024)
    await f.journal.create(f.record)
    expect(await new DeviceRecordingRestoreJournal(f.directory, f.sealed).remainingAuthorityCapacity()).toBe(1023)
    await f.journal.resolve(f.record, { kind: 'begin-not-dispatched' })
    expect(await f.journal.remainingAuthorityCapacity()).toBe(1023)
    expect(await f.journal.remainingAuthorityCapacity()).toBeGreaterThanOrEqual(558)
    writeFileSync(join(f.directory, `${f.record.id}.rstr2.resolved.sealed`), 'crashed-receipt')
    await expect(f.journal.remainingAuthorityCapacity()).rejects.toThrow()
  })
  it('never reports planning capacity with unavailable encryption, unknown entries or corrupt ownership', async () => {
    for (const cause of ['encryption', 'unknown', 'ownership'] as const) {
      const f = fixture()
      if (cause === 'encryption') f.available.value = false
      if (cause === 'unknown') writeFileSync(join(f.directory, 'unknown.sealed'), 'x')
      if (cause === 'ownership') writeFileSync(f.path, '')
      await expect(f.journal.remainingAuthorityCapacity()).rejects.toThrow()
    }
  })
  it.each(['../arbitrary', 'C:/other', '', `${randomUUID()}/child`])('rejects unsafe journal ID %s', async id => {
    const f = fixture()
    await expect(f.journal.load(id)).rejects.toThrow('reference')
    await expect(f.journal.create({ ...f.record, id })).rejects.toThrow('reference')
    expect(readdirSync(f.directory)).toEqual([])
  })
  it.each([0, 1, 16385])('rejects invalid encrypted record byte count %s without deleting it', async size => {
    const f = fixture(); writeFileSync(f.path, Buffer.alloc(size))
    await expect(f.journal.load(f.record.id)).rejects.toThrow()
    expect(readFileSync(f.path)).toHaveLength(size)
  })
  it('rejects authenticated ciphertext tampering and different sealing key', async () => {
    const f = fixture(), other = fixture(); await f.journal.create(f.record)
    await expect(new DeviceRecordingRestoreJournal(f.directory, other.sealed).load(f.record.id)).rejects.toThrow('Invalid')
    const bytes = readFileSync(f.path); bytes[bytes.length - 1] ^= 1; writeFileSync(f.path, bytes)
    await expect(f.journal.load(f.record.id)).rejects.toThrow('Invalid')
    expect(readFileSync(f.path)).toEqual(bytes)
  })
  it.each(['token-object', 'zero-token', 'short-sha', 'wrong-version', 'extra-key', 'path-relative', 'wrong-id'])('rejects encrypted malformed schema: %s', async kind => {
    const f = fixture(), value = JSON.parse(JSON.stringify({ ...f.record, session: { ...f.record.session,
      ownerToken: Buffer.from(f.record.session.ownerToken).toString('hex'), sourceSha256: Buffer.from(f.record.session.sourceSha256).toString('hex') } }))
    if (kind === 'token-object') value.session.ownerToken = { 0: 1 }
    if (kind === 'zero-token') value.session.ownerToken = '00'.repeat(16)
    if (kind === 'short-sha') value.session.sourceSha256 = '12'
    if (kind === 'wrong-version') value.session.versionNumber = 393986
    if (kind === 'extra-key') value.session.rendererPath = 'arbitrary'
    if (kind === 'path-relative') value.source.path = '../private-source.bin'
    if (kind === 'wrong-id') value.id = randomUUID()
    writeFileSync(f.path, f.sealed.encryptString(JSON.stringify(value)))
    await expect(f.journal.load(f.record.id)).rejects.toThrow('Invalid')
  })
  it('enumerates a new process unresolved ownership and binds an encrypted immutable resolution receipt', async () => {
    const f = fixture(); await f.journal.create(f.record)
    const authority = readFileSync(f.path)
    expect(await new DeviceRecordingRestoreJournal(f.directory, f.sealed).list()).toEqual([f.record])
    await f.journal.resolve(f.record, { kind: 'begin-not-dispatched' })
    const receiptPath = join(f.directory, `${f.record.id}.rstr2.resolved.sealed`), receipt = readFileSync(receiptPath)
    expect(receipt.includes(Buffer.from('begin-not-dispatched'))).toBe(false)
    expect(readFileSync(f.path)).toEqual(authority)
    const restarted = new DeviceRecordingRestoreJournal(f.directory, f.sealed)
    expect(await restarted.list()).toEqual([]); expect(await restarted.isResolved(f.record.id)).toBe(true)
    await restarted.resolve(f.record, { kind: 'begin-not-dispatched' })
    expect(readFileSync(receiptPath)).toEqual(receipt)
    writeFileSync(receiptPath, Buffer.from('crashed-receipt'))
    await expect(restarted.list()).rejects.toThrow()
    expect(readFileSync(f.path)).toEqual(authority)
  })
  it('rejects altered authoritative ownership and cross-record copied resolution receipts', async () => {
    const f = fixture(), second = { ...f.record, id: randomUUID() }; await f.journal.create(f.record); await f.journal.create(second)
    await expect(f.journal.resolve({ ...f.record, recordingId: 'other-id' }, { kind: 'begin-not-dispatched' })).rejects.toThrow('binding')
    await f.journal.resolve(f.record, { kind: 'begin-not-dispatched' })
    const receipt = readFileSync(join(f.directory, `${f.record.id}.rstr2.resolved.sealed`))
    writeFileSync(join(f.directory, `${second.id}.rstr2.resolved.sealed`), receipt)
    await expect(f.journal.list()).rejects.toThrow('resolution')
  })
  it('refuses receipt evidence inconsistent with immutable serial, version, SHA or length', async () => {
    const f = fixture(); await f.journal.create(f.record)
    const base = { kind: 'full-sha256-readback' as const, serialNumber: f.record.session.serialNumber, versionNumber: 393988 as const,
      connectionSessionId: 7, totalBytes: 0, sha256: Buffer.from(f.record.session.sourceSha256).toString('hex') }
    for (const evidence of [{ ...base, serialNumber: 'OTHER' }, { ...base, sha256: 'ff'.repeat(32) }, { ...base, totalBytes: 1 }, { ...base, connectionSessionId: -1 }]) {
      await expect(f.journal.resolve(f.record, evidence)).rejects.toThrow('evidence')
    }
    expect(await f.journal.list()).toEqual([f.record])
  })
  it('fails closed on unknown, orphaned and excessive entries before decrypting or creating more authority', async () => {
    const f = fixture(); writeFileSync(join(f.directory, 'unknown.sealed'), 'x')
    await expect(f.journal.list()).rejects.toThrow('Unknown')
    await expect(f.journal.create(f.record)).rejects.toThrow('Unknown')
    const orphan = fixture(); writeFileSync(join(orphan.directory, `${randomUUID()}.rstr2.resolved.sealed`), 'x')
    await expect(orphan.journal.list()).rejects.toThrow('ownership')
    const full = fixture()
    // Real bounded filesystem enumeration reaches the limit before decryption;
    // these deliberately unknown crash records must be preserved, never evicted.
    for (let i = 0; i <= RESTORE_JOURNAL_MAX_OWNERSHIP; i++) writeFileSync(join(full.directory, `${randomUUID()}.rstr2.sealed`), 'x')
    await expect(full.journal.list()).rejects.toThrow('ownership')
    expect(readdirSync(full.directory)).toHaveLength(RESTORE_JOURNAL_MAX_OWNERSHIP + 1)
  })
})
