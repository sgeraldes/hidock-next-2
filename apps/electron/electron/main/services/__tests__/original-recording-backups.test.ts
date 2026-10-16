/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { claimHostDownloadTransfer, OriginalRecordingBackupStore, registerHostDownloadTransfer } from '../original-recording-backups'
import type { OriginalBackupDatabase } from '../original-recording-backups'
import type { ResumeSource } from '../download-resume'
import type { StagedRecording } from '../download-staging'
import { downloadWithResume, releaseResumedDownload } from '../download-resume'

const folders: string[] = []
const open: Array<{ close(): unknown }> = []
afterEach(() => {
  for (const db of open.splice(0)) db.close()
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('hidock-original-backup-')) throw Error('Unsafe fixture cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** Real SQLite behind the getDatabase() sql.js-compatible shape (run + exec returning column groups). */
function adapter(file: string): OriginalBackupDatabase & { close(): void } {
  const db = new Database(file); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); open.push(db)
  return {
    run: (sql, params = []) => db.prepare(sql).run(...params),
    exec: (sql, params = []) => {
      const statement = db.prepare(sql)
      if (!statement.reader) { statement.run(...params); return [] }
      const values = statement.raw(true).all(...params) as unknown[][]
      return values.length ? [{ columns: statement.columns().map(c => c.name), values }] : []
    },
    close: () => { db.close(); open.splice(open.findIndex(h => h === db), 1) }
  }
}
function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'hidock-original-backup-')); folders.push(folder)
  const recordings = join(folder, 'Recordings'); const dbFile = join(folder, 'receipts.sqlite')
  mkdirSync(recordings)
  return { folder, recordings, dbFile }
}

const SOURCE = (over: Partial<ResumeSource> = {}): ResumeSource => ({ deviceId: 'd'.repeat(64), sessionId: 'session-1', model: 'hidock-h1e',
  firmware: '393988:6.3.4', filename: '2026Oct12-111955-Rec83.hda', size: 24, signature: 'b'.repeat(32), listingComplete: true, completed: true, ...over })

/** A real main-owned resumable transfer: downloadWithResume over a synthetic in-memory device adapter. */
async function transfer(directory: string, bytes: Buffer, over: Partial<ResumeSource> = {}) {
  const expected = SOURCE({ size: bytes.length, ...over })
  const staged = await downloadWithResume({ directory, expected, adapter: { snapshot: async () => expected,
    readRange: async (_n, _s, offset, count, onChunk) => { onChunk(bytes.subarray(offset, offset + count)); return { status: 'complete', offset, count, received: count, reason: null } } } })
  return { staged, expected }
}
const publish = (directory: string, name: string, bytes: Buffer) => { const path = join(directory, name); writeFileSync(path, bytes); return path }

describe('original recording backup receipts on real SQLite', () => {
  it('a main-owned resumable transfer yields a host-download receipt with the host digest, captured name, canonical path and length', async () => {
    const { recordings, dbFile } = setup(), bytes = Buffer.from('device-original-bytes-0123')
    const { staged, expected } = await transfer(recordings, bytes)
    try {
      expect(registerHostDownloadTransfer(staged, expected)).toBe(true)
      const claimed = claimHostDownloadTransfer(staged, expected.filename)!
      expect(claimed).toMatchObject({ originalFilename: '2026Oct12-111955-Rec83.hda', totalBytes: bytes.length, sha256: sha(bytes), catalogSignatureMd5: 'b'.repeat(32) })
      const path = publish(recordings, '2026Oct12-111955-Rec83.wav', bytes)
      const store = new OriginalRecordingBackupStore({ db: adapter(dbFile), now: () => new Date('2026-10-12T12:00:00.000Z') })
      const receipt = store.recordHostDownload({ recordingId: 'rec-1', publishedPath: path, transfer: claimed })
      expect(receipt).toEqual({ recordingId: 'rec-1', receiptVersion: 1, originKind: 'host-download-v1', originalFilename: '2026Oct12-111955-Rec83.hda',
        canonicalPath: realpathSync.native(path), totalBytes: bytes.length, sha256: sha(bytes), deviceIdSha256: 'd'.repeat(64), model: 'hidock-h1e',
        firmware: '393988:6.3.4', catalogSignatureMd5: 'b'.repeat(32), acquiredAt: '2026-10-12T12:00:00.000Z' })
    } finally { releaseResumedDownload(staged) }
  })

  it('survives closing and reopening the SQLite file, and stays byte-for-byte the same receipt', async () => {
    const { recordings, dbFile } = setup(), bytes = Buffer.from('persisted-bytes-0123456789')
    const { staged, expected } = await transfer(recordings, bytes)
    try {
      registerHostDownloadTransfer(staged, expected)
      const first = adapter(dbFile), claimed = claimHostDownloadTransfer(staged, expected.filename)!
      const written = new OriginalRecordingBackupStore({ db: first }).recordHostDownload({ recordingId: 'rec-1', publishedPath: publish(recordings, 'persisted.wav', bytes), transfer: claimed })
      first.close()
      const reopened = new OriginalRecordingBackupStore({ db: adapter(dbFile) })
      expect(reopened.latest('rec-1')).toEqual(written)
      expect(reopened.list('rec-1')).toEqual([written])
    } finally { releaseResumedDownload(staged) }
  })

  it('is immutable: UPDATE, DELETE and INSERT OR REPLACE are all refused and the stored receipt does not change', async () => {
    const { recordings, dbFile } = setup(), bytes = Buffer.from('immutable-bytes-0123456')
    const { staged, expected } = await transfer(recordings, bytes), db = adapter(dbFile)
    try {
      registerHostDownloadTransfer(staged, expected)
      const store = new OriginalRecordingBackupStore({ db }), claimed = claimHostDownloadTransfer(staged, expected.filename)!
      const receipt = store.recordHostDownload({ recordingId: 'rec-1', publishedPath: publish(recordings, 'imm.wav', bytes), transfer: claimed })
      expect(() => db.run(`UPDATE original_recording_backup_receipts SET original_filename = 'x.wav' WHERE recording_id = ?`, ['rec-1'])).toThrow(/immutable/)
      expect(() => db.run(`UPDATE original_recording_backup_receipts SET sha256 = ? WHERE recording_id = ?`, ['0'.repeat(64), 'rec-1'])).toThrow(/immutable/)
      expect(() => db.run('DELETE FROM original_recording_backup_receipts WHERE recording_id = ?', ['rec-1'])).toThrow(/immutable/)
      expect(() => db.run(`INSERT OR REPLACE INTO original_recording_backup_receipts (recording_id, receipt_version, origin_kind, original_filename, canonical_path, total_bytes, sha256,
        device_id_sha256, model, firmware, catalog_signature_md5, acquired_at) VALUES (?, 1, 'host-download-v1', 'evil.wav', '/x', 1, ?, 'd', 'm', 'f', NULL, 'now')`, ['rec-1', '1'.repeat(64)])).toThrow(/immutable/)
      expect(store.list('rec-1')).toEqual([receipt])
    } finally { releaseResumedDownload(staged) }
  })

  it('a replacement appends version 2 and the first receipt is preserved untouched', async () => {
    const { recordings, dbFile } = setup(), store = new OriginalRecordingBackupStore({ db: adapter(dbFile) })
    const short = Buffer.from('short-original-bytes'), full = Buffer.from('short-original-bytes-and-the-rest')
    const a = await transfer(recordings, short, { filename: '2026Oct12-111955-Rec83.hda' })
    registerHostDownloadTransfer(a.staged, a.expected)
    const v1 = store.recordHostDownload({ recordingId: 'rec-1', publishedPath: publish(recordings, 'rec83.wav', short), transfer: claimHostDownloadTransfer(a.staged, a.expected.filename)! })
    releaseResumedDownload(a.staged)
    const b = await transfer(recordings, full, { filename: '2026Oct12-111955-Rec83.hda', sessionId: 'session-2' })
    try {
      registerHostDownloadTransfer(b.staged, b.expected)
      const v2 = store.recordHostDownload({ recordingId: 'rec-1', publishedPath: publish(recordings, 'rec83.wav', full), transfer: claimHostDownloadTransfer(b.staged, b.expected.filename)! })
      expect(v1.receiptVersion).toBe(1); expect(v2.receiptVersion).toBe(2)
      expect(store.list('rec-1')).toEqual([v1, v2]); expect(store.latest('rec-1')).toEqual(v2)
      expect(v1.sha256).toBe(sha(short)); expect(v2.sha256).toBe(sha(full))
    } finally { releaseResumedDownload(b.staged) }
  })

  it('re-recording the same terms is idempotent, the same digest under different terms or an A-B-A sequence is refused', async () => {
    const { recordings, dbFile } = setup(), store = new OriginalRecordingBackupStore({ db: adapter(dbFile) })
    const one = Buffer.from('aaaaaaaaaaaaaaaaaaaa'), two = Buffer.from('bbbbbbbbbbbbbbbbbbbbbbbb')
    const make = async (bytes: Buffer, name: string, session: string) => {
      const t = await transfer(recordings, bytes, { sessionId: session }); registerHostDownloadTransfer(t.staged, t.expected)
      const claimed = claimHostDownloadTransfer(t.staged, t.expected.filename)!; releaseResumedDownload(t.staged)
      return { claimed, path: publish(recordings, name, bytes) }
    }
    const a1 = await make(one, 'a.wav', 's1')
    const first = store.recordHostDownload({ recordingId: 'rec-1', publishedPath: a1.path, transfer: a1.claimed })
    expect(() => store.recordHostDownload({ recordingId: 'rec-1', publishedPath: a1.path, transfer: a1.claimed })).toThrow(/already used/)
    // A second genuine transfer with identical terms is idempotent: same receipt, no new version.
    const again = await make(one, 'a.wav', 's1b')
    expect(store.recordHostDownload({ recordingId: 'rec-1', publishedPath: again.path, transfer: again.claimed })).toEqual(first)
    expect(store.list('rec-1')).toHaveLength(1)
    const b = await make(two, 'b.wav', 's2'); store.recordHostDownload({ recordingId: 'rec-1', publishedPath: b.path, transfer: b.claimed })
    const a2 = await make(one, 'a2.wav', 's3')
    expect(() => store.recordHostDownload({ recordingId: 'rec-1', publishedPath: a2.path, transfer: a2.claimed })).toThrow()
    expect(store.list('rec-1').map(r => r.receiptVersion)).toEqual([1, 2])
  })

  it('refuses to store when the published file is not the received transfer (wrong length, missing, symlink)', async () => {
    const { recordings, dbFile } = setup(), store = new OriginalRecordingBackupStore({ db: adapter(dbFile) }), bytes = Buffer.from('exact-length-bytes-here')
    // Claims are one-shot, so every attempt gets its own genuine main-owned lease and claim.
    let attempts = 0
    const attempt = async (publishedPath: string) => {
      const { staged, expected } = await transfer(recordings, bytes, { sessionId: `attempt-${attempts++}` })
      try {
        registerHostDownloadTransfer(staged, expected)
        const claimed = claimHostDownloadTransfer(staged, expected.filename)!
        return () => store.recordHostDownload({ recordingId: 'rec-1', publishedPath, transfer: claimed })
      } finally { releaseResumedDownload(staged) }
    }
    expect(await attempt(publish(recordings, 'short.wav', Buffer.from('short')))).toThrow(/does not match/)
    expect(await attempt(join(recordings, 'missing.wav'))).toThrow()
    const real = publish(recordings, 'real.wav', bytes), link = join(recordings, 'link.wav')
    try { symlinkSync(real, link, 'file'); expect(await attempt(link)).toThrow(/does not match/) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    expect(await attempt('relative.wav')).toThrow(/Invalid published path/)
    expect(store.list('rec-1')).toEqual([])
  })

  it('transport ownership: Buffers, unregistered objects, forged objects and released leases never produce evidence', async () => {
    const { recordings } = setup(), bytes = Buffer.from('owned-transport-bytes!!')
    expect(claimHostDownloadTransfer(Buffer.from('renderer-supplied'), 'x.hda')).toBeNull()
    const forged: StagedRecording = { path: join(recordings, '.hidock-resume-' + 'a'.repeat(64) + '.partial'), length: bytes.length, sha256: sha(bytes) }
    expect(registerHostDownloadTransfer(forged, SOURCE({ size: bytes.length }))).toBe(false)
    expect(registerHostDownloadTransfer(Buffer.from('x') as unknown as StagedRecording, SOURCE())).toBe(false)
    expect(claimHostDownloadTransfer(forged, '2026Oct12-111955-Rec83.hda')).toBeNull()
    const { staged, expected } = await transfer(recordings, bytes)
    expect(claimHostDownloadTransfer(staged, expected.filename)).toBeNull() // owned, but never registered
    expect(registerHostDownloadTransfer(staged, expected)).toBe(true)
    expect(registerHostDownloadTransfer(staged, expected)).toBe(false) // one registration per transfer
    releaseResumedDownload(staged)
    expect(claimHostDownloadTransfer(staged, expected.filename)).toBeNull() // lease released: no longer main-owned
  })

  it('a claim is single-use and bound to the queue filename, length and digest', async () => {
    const { recordings } = setup(), bytes = Buffer.from('claim-binding-bytes-012')
    const { staged, expected } = await transfer(recordings, bytes)
    try {
      registerHostDownloadTransfer(staged, expected)
      expect(claimHostDownloadTransfer(staged, 'Some-Other-Rec01.hda')).toBeNull() // wrong name consumes the registration
      expect(claimHostDownloadTransfer(staged, expected.filename)).toBeNull()
    } finally { releaseResumedDownload(staged) }
    const second = await transfer(recordings, bytes, { sessionId: 'two' })
    try {
      registerHostDownloadTransfer(second.staged, second.expected)
      expect(claimHostDownloadTransfer({ ...second.staged, length: second.staged.length - 1 }, second.expected.filename)).toBeNull()
      expect(claimHostDownloadTransfer(second.staged, second.expected.filename)).not.toBeNull()
      expect(claimHostDownloadTransfer(second.staged, second.expected.filename)).toBeNull()
    } finally { releaseResumedDownload(second.staged) }
  })

  it.each([
    ['incomplete listing', { listingComplete: false }], ['not completed', { completed: false }], ['filename not restorable', { filename: 'bad/name.hda' }],
    ['uppercase extension', { filename: 'REC.HDA' }], ['device id not a digest', { deviceId: 'serial-123' }], ['no model', { model: '' }], ['no firmware', { firmware: '' }]
  ] as const)('does not register evidence from a snapshot with %s', async (_kind, over) => {
    const { recordings } = setup(), bytes = Buffer.from('snapshot-validation-bytes')
    const { staged, expected } = await transfer(recordings, bytes)
    try { expect(registerHostDownloadTransfer(staged, { ...expected, ...over })).toBe(false); expect(claimHostDownloadTransfer(staged, expected.filename)).toBeNull() }
    finally { releaseResumedDownload(staged) }
  })

  it('a non-hex catalog signature is dropped, never stored as a digest claim', async () => {
    const { recordings, dbFile } = setup(), bytes = Buffer.from('signature-handling-bytes')
    const { staged, expected } = await transfer(recordings, bytes, { signature: 'not-an-md5' })
    try {
      registerHostDownloadTransfer(staged, expected)
      const receipt = new OriginalRecordingBackupStore({ db: adapter(dbFile) }).recordHostDownload({ recordingId: 'rec-1', publishedPath: publish(recordings, 's.wav', bytes), transfer: claimHostDownloadTransfer(staged, expected.filename)! })
      expect(receipt.catalogSignatureMd5).toBeNull()
    } finally { releaseResumedDownload(staged) }
  })

  // LABEL: the lease below is real (downloadWithResume, real staged file IO, real host SHA-256) but the "device" is a
  // synthetic in-memory ResumeAdapter. This proves the host-side one-shot binding. It is NOT real device provenance
  // and is not evidence that any physical download happened.
  it('a spent claim cannot be reused: not for the same recording, not for another recording id, and a failed attempt still spends it', async () => {
    const { recordings, dbFile } = setup(), bytes = Buffer.from('one-shot-claim-bytes-012'), store = new OriginalRecordingBackupStore({ db: adapter(dbFile) })
    const { staged, expected } = await transfer(recordings, bytes)
    try {
      registerHostDownloadTransfer(staged, expected)
      const claimed = claimHostDownloadTransfer(staged, expected.filename)!, path = publish(recordings, 'once.wav', bytes)
      const first = store.recordHostDownload({ recordingId: 'rec-A', publishedPath: path, transfer: claimed })
      expect(first.receiptVersion).toBe(1)
      expect(() => store.recordHostDownload({ recordingId: 'rec-A', publishedPath: path, transfer: claimed })).toThrow(/already used/)
      expect(() => store.recordHostDownload({ recordingId: 'rec-B', publishedPath: path, transfer: claimed })).toThrow(/already used/)
      expect(store.list('rec-A')).toEqual([first]); expect(store.list('rec-B')).toEqual([])
    } finally { releaseResumedDownload(staged) }
    const other = await transfer(recordings, bytes, { sessionId: 'second' })
    try {
      registerHostDownloadTransfer(other.staged, other.expected)
      const claimed = claimHostDownloadTransfer(other.staged, other.expected.filename)!
      expect(() => store.recordHostDownload({ recordingId: 'rec-C', publishedPath: join(recordings, 'missing.wav'), transfer: claimed })).toThrow()
      expect(() => store.recordHostDownload({ recordingId: 'rec-D', publishedPath: publish(recordings, 'late.wav', bytes), transfer: claimed })).toThrow(/already used/)
      expect(store.list('rec-C')).toEqual([]); expect(store.list('rec-D')).toEqual([])
    } finally { releaseResumedDownload(other.staged) }
  })

  it('the stored digest is the received-stream digest: a same-size edit of the published file does not rewrite it', async () => {
    const { recordings, dbFile } = setup(), received = Buffer.from('received-stream-bytes-01')
    const sameSize = Buffer.alloc(received.length, 0x7a), { staged, expected } = await transfer(recordings, received)
    try {
      registerHostDownloadTransfer(staged, expected)
      const receipt = new OriginalRecordingBackupStore({ db: adapter(dbFile) }).recordHostDownload({
        recordingId: 'rec-1', publishedPath: publish(recordings, 'drift.wav', sameSize), transfer: claimHostDownloadTransfer(staged, expected.filename)! })
      expect(receipt.sha256).toBe(sha(received)); expect(receipt.sha256).not.toBe(sha(sameSize))
    } finally { releaseResumedDownload(staged) }
  })

  it('recordHostDownload refuses evidence that did not come from a claim', async () => {
    const { recordings, dbFile } = setup(), bytes = Buffer.from('unclaimed-evidence-bytes')
    const store = new OriginalRecordingBackupStore({ db: adapter(dbFile) })
    const forged = { originalFilename: '2026Oct12-111955-Rec83.hda', totalBytes: bytes.length, sha256: sha(bytes), deviceIdSha256: 'd'.repeat(64), model: 'hidock-h1e', firmware: '1', catalogSignatureMd5: null }
    expect(() => store.recordHostDownload({ recordingId: 'rec-1', publishedPath: publish(recordings, 'f.wav', bytes), transfer: forged })).toThrow(/claimed main-owned transfer/)
    expect(store.list('rec-1')).toEqual([])
  })

  it('owned-upload receipts carry no device provenance and are a separate kind', async () => {
    const { recordings, dbFile } = setup(), bytes = Buffer.from('synthetic-owned-fixture'), path = publish(recordings, 'fixture.wav', bytes)
    const store = new OriginalRecordingBackupStore({ db: adapter(dbFile) })
    const receipt = await store.registerOwnedUpload({ recordingId: 'fixture-1', originalFilename: '2026Oct12-111955-Rec83.wav', path })
    expect(receipt).toMatchObject({ originKind: 'owned-upload-v1', receiptVersion: 1, sha256: sha(bytes), totalBytes: bytes.length,
      deviceIdSha256: null, model: null, firmware: null, catalogSignatureMd5: null, originalFilename: '2026Oct12-111955-Rec83.wav' })
    await expect(store.registerOwnedUpload({ recordingId: 'fixture-1', originalFilename: '../x.wav', path })).rejects.toThrow()
    await expect(store.registerOwnedUpload({ recordingId: 'fixture-1', originalFilename: 'ok.wav', path: 'relative.wav' })).rejects.toThrow()
    await expect(store.registerOwnedUpload({ recordingId: 'fixture-1', originalFilename: 'ok.wav', path: recordings })).rejects.toThrow()
  })

  it('the schema itself rejects a device kind without device fields and an owned kind that claims device fields', () => {
    const { dbFile } = setup(), db = adapter(dbFile), store = new OriginalRecordingBackupStore({ db }); store.list('x')
    const insert = (kind: string, device: string | null, model: string | null) => () => db.run(`INSERT INTO original_recording_backup_receipts
      (recording_id, receipt_version, origin_kind, original_filename, canonical_path, total_bytes, sha256, device_id_sha256, model, firmware, catalog_signature_md5, acquired_at)
      VALUES ('r', 1, ?, 'a.wav', '/a', 1, ?, ?, ?, ?, NULL, 'now')`, [kind, 'a'.repeat(64), device, model, model])
    expect(insert('host-download-v1', null, null)).toThrow(); expect(insert('owned-upload-v1', 'd', 'm')).toThrow(); expect(insert('mystery-kind', null, null)).toThrow()
    expect(() => db.run(`INSERT INTO original_recording_backup_receipts VALUES ('r', 1, 'owned-upload-v1', 'a.wav', '/a', 1, ?, NULL, NULL, NULL, NULL, 'now')`, ['A'.repeat(64)])).toThrow()
    expect(() => db.run(`INSERT INTO original_recording_backup_receipts VALUES ('r', 0, 'owned-upload-v1', 'a.wav', '/a', 1, ?, NULL, NULL, NULL, NULL, 'now')`, ['a'.repeat(64)])).toThrow()
  })

  it('reads fail closed on bad identity input', () => {
    const { dbFile } = setup(), store = new OriginalRecordingBackupStore({ db: adapter(dbFile) })
    expect(store.latest('')).toBeNull(); expect(store.list('')).toEqual([]); expect(store.latest('never-receipted')).toBeNull()
  })
})
