/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DeviceScratchJournal, SCRATCH_JOURNAL_MAX_OWNERSHIP } from '../device-scratch-journal'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('hidock-scratch-journal-')) throw Error('Unsafe fixture cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hidock-scratch-journal-')); folders.push(directory)
  const key = randomBytes(32), availability = { value: true }
  // AES-GCM models the injected OS facade; real disk IO, not Windows DPAPI.
  const sealed = {
    isEncryptionAvailable: () => availability.value,
    encryptString: (text: string) => {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
    },
    decryptString: (data: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
  const id = randomUUID(), session = { uploadId: 123, ownerToken: 456, totalBytes: 1025, wholeCrc32: 0xabcd0123, serialNumber: 'PRIVATE-TEST-SERIAL', connectionSessionId: 5, versionNumber: 393986 as const }
  const journal = new DeviceScratchJournal(directory, sealed)
  return { directory, id, session, sealed, journal, availability, path: join(directory, `${id}.sealed`) }
}
describe('immutable sealed ownership journal on a real temporary filesystem', () => {
  it('writes one sealed record, round-trips through a fresh instance, and never replaces it', async () => {
    const f = fixture(), original = await f.journal.create(f.id, f.session)
    const data = readFileSync(f.path)
    expect(data.length).toBeLessThanOrEqual(16384)
    expect(data.includes(Buffer.from(f.session.serialNumber))).toBe(false)
    expect(data.includes(Buffer.from('ownerToken'))).toBe(false)
    expect(await new DeviceScratchJournal(f.directory, f.sealed).load(f.id.toUpperCase())).toEqual(original)
    await expect(f.journal.create(f.id, { ...f.session, ownerToken: 789 })).rejects.toThrow()
    expect(readFileSync(f.path)).toEqual(data)
    expect(readdirSync(f.directory)).toEqual([`${f.id}.sealed`])
  })
  it('snapshots caller metadata before asynchronous disk IO', async () => {
    const f = fixture(), expected = { ...f.session }, pending = f.journal.create(f.id, f.session)
    f.session.ownerToken = 999
    await pending
    expect((await f.journal.load(f.id)).session).toEqual(expected)
  })
  it('refuses unavailable encryption without creating a directory or a plaintext fallback', async () => {
    const f = fixture(); f.availability.value = false
    await expect(f.journal.create(f.id, f.session)).rejects.toThrow('unavailable')
    await expect(f.journal.load(f.id)).rejects.toThrow('unavailable')
    expect(readdirSync(f.directory)).toEqual([])
  })
  it.each(['../escape', 'C:/foreign', '', '1234', `${randomUUID()}/child`])('rejects unsafe reference %s before disk IO', async id => {
    const f = fixture()
    await expect(f.journal.create(id, f.session)).rejects.toThrow('Invalid')
    await expect(f.journal.load(id)).rejects.toThrow('Invalid')
    expect(readdirSync(f.directory)).toEqual([])
  })
  it.each([0, 1, 16385])('rejects empty, truncated or oversized ciphertext (%s bytes)', async length => {
    const f = fixture(); writeFileSync(f.path, Buffer.alloc(length))
    await expect(f.journal.load(f.id)).rejects.toThrow()
    expect(readFileSync(f.path)).toHaveLength(length)
  })
  it('rejects modified authenticated ciphertext and preserves the damaged record', async () => {
    const f = fixture(); await f.journal.create(f.id, f.session)
    const bytes = readFileSync(f.path); bytes[bytes.length - 1] ^= 1; writeFileSync(f.path, bytes)
    await expect(f.journal.load(f.id)).rejects.toThrow('Invalid')
    expect(readFileSync(f.path)).toEqual(bytes)
  })
  it.each(['wrong-id', 'wrong-version', 'extra-field', 'invalid-total', 'missing-token'])('rejects sealed but invalid schema: %s', async kind => {
    const f = fixture()
    const record = { schemaVersion: 1, id: f.id, createdAt: new Date().toISOString(), session: { ...f.session } } as Record<string, any>
    if (kind === 'wrong-id') record.id = randomUUID()
    if (kind === 'wrong-version') record.session.versionNumber = 393985
    if (kind === 'extra-field') record.session.path = 'foreign'
    if (kind === 'invalid-total') record.session.totalBytes = 0x800000
    if (kind === 'missing-token') delete record.session.ownerToken
    writeFileSync(f.path, f.sealed.encryptString(JSON.stringify(record)))
    await expect(f.journal.load(f.id)).rejects.toThrow('Invalid')
  })
  it('rejects a directory entry instead of a record and fails closed on crypto backend exceptions', async () => {
    const f = fixture(); mkdirSync(f.path)
    await expect(f.journal.load(f.id)).rejects.toThrow('Invalid')
    const unavailable = new DeviceScratchJournal(f.directory, { ...f.sealed, isEncryptionAvailable: () => { throw Error('private crypto error') } })
    expect(unavailable.isAvailable()).toBe(false)
    await expect(unavailable.create(randomUUID(), f.session)).rejects.toThrow('unavailable')
  })
  it.each([0, 16385])('does not write invalid encrypted output length %s', async length => {
    const f = fixture(), journal = new DeviceScratchJournal(f.directory, { ...f.sealed, encryptString: () => Buffer.alloc(length) })
    await expect(journal.create(f.id, f.session)).rejects.toThrow('unavailable')
    expect(readdirSync(f.directory)).toEqual([])
  })
  it('rejects a record sealed by a different key without replacing it', async () => {
    const f = fixture(), foreign = fixture(); await f.journal.create(f.id, f.session)
    const original = readFileSync(f.path)
    await expect(new DeviceScratchJournal(f.directory, foreign.sealed).load(f.id)).rejects.toThrow('Invalid')
    expect(readFileSync(f.path)).toEqual(original)
  })
  it('enumerates unresolved historical records and seals binding-checked immutable completion receipts across restart', async () => {
    const f = fixture(), record = await f.journal.create(f.id, f.session), original = readFileSync(f.path)
    expect(await new DeviceScratchJournal(f.directory, f.sealed).list()).toEqual([record])
    await f.journal.resolve(record, { kind: 'native-finished', operation: 'status', serialNumber: f.session.serialNumber,
      versionNumber: f.session.versionNumber, connectionSessionId: 8, progressBytes: f.session.totalBytes })
    const receiptPath = join(f.directory, `${f.id}.resolved.sealed`), receipt = readFileSync(receiptPath)
    expect(receipt.includes(Buffer.from('native-finished'))).toBe(false)
    expect(readFileSync(f.path)).toEqual(original)
    const fresh = new DeviceScratchJournal(f.directory, f.sealed)
    expect(await fresh.list()).toEqual([]); expect(await fresh.isResolved(f.id)).toBe(true)
    await fresh.resolve(record, { kind: 'begin-not-dispatched' })
    expect(readFileSync(receiptPath)).toEqual(receipt)
  })
  it('rejects new ownership at the real filesystem ceiling without consuming reserved resolution capacity', async () => {
    const f = fixture(), record = { schemaVersion: 1 as const, id: f.id, createdAt: new Date().toISOString(), session: f.session }
    for (let i = 0; i < SCRATCH_JOURNAL_MAX_OWNERSHIP; i++) {
      const value = { ...record, id: i === 0 ? f.id : randomUUID() }
      writeFileSync(join(f.directory, `${value.id}.sealed`), f.sealed.encryptString(JSON.stringify(value)))
    }
    await expect(f.journal.create(randomUUID(), f.session)).rejects.toThrow('capacity exhausted')
    await f.journal.resolve(record, { kind: 'begin-not-dispatched' })
    expect(await f.journal.isResolved(f.id)).toBe(true)
    expect(readdirSync(f.directory)).toHaveLength(SCRATCH_JOURNAL_MAX_OWNERSHIP + 1)
  })
  it('rejects copied receipts, changed authority and wrong native identity/progress evidence', async () => {
    const f = fixture(), record = await f.journal.create(f.id, f.session), other = await f.journal.create(randomUUID(), f.session)
    const evidence = { kind: 'native-finished' as const, operation: 'status' as const, serialNumber: f.session.serialNumber,
      versionNumber: f.session.versionNumber, connectionSessionId: 8, progressBytes: f.session.totalBytes }
    await expect(f.journal.resolve({ ...record, session: { ...record.session, ownerToken: 9 } }, evidence)).rejects.toThrow('binding')
    for (const proof of [{ ...evidence, serialNumber: 'OTHER' }, { ...evidence, progressBytes: 1 }, { ...evidence, versionNumber: 393988 as const }]) await expect(f.journal.resolve(record, proof)).rejects.toThrow('evidence')
    await f.journal.resolve(record, evidence)
    writeFileSync(join(f.directory, `${other.id}.resolved.sealed`), readFileSync(join(f.directory, `${f.id}.resolved.sealed`)))
    await expect(f.journal.list()).rejects.toThrow('resolution')
  })
  it('keeps truncated receipts and authorities unresolved; unknown, orphan and over-limit entries fail closed', async () => {
    const f = fixture(), record = await f.journal.create(f.id, f.session)
    await f.journal.resolve(record, { kind: 'begin-not-dispatched' })
    writeFileSync(join(f.directory, `${f.id}.resolved.sealed`), Buffer.alloc(0))
    await expect(f.journal.list()).rejects.toThrow()
    expect(readFileSync(f.path).length).toBeGreaterThan(0)
    const unknown = fixture(); writeFileSync(join(unknown.directory, 'unknown.sealed'), 'unknown')
    await expect(unknown.journal.list()).rejects.toThrow('Unknown')
    await expect(unknown.journal.create(unknown.id, unknown.session)).rejects.toThrow('Unknown')
    const orphan = fixture(); writeFileSync(join(orphan.directory, `${randomUUID()}.resolved.sealed`), 'unknown')
    await expect(orphan.journal.list()).rejects.toThrow('ownership')
    const full = fixture()
    for (let i = 0; i <= SCRATCH_JOURNAL_MAX_OWNERSHIP; i++) writeFileSync(join(full.directory, `${randomUUID()}.sealed`), 'unknown')
    await expect(full.journal.list()).rejects.toThrow('ownership')
    expect(readdirSync(full.directory)).toHaveLength(SCRATCH_JOURNAL_MAX_OWNERSHIP + 1)
  })
})
