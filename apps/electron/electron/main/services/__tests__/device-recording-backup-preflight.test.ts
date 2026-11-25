/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { planDeviceRecordingBackupPreflight } from '../device-recording-backup-preflight'
import type { DeviceBackupLocalRow, DeviceRecordingBackupPreflightDependencies } from '../device-recording-backup-preflight'
import type { DeviceFsCatalog } from '../device-file-system'
import type { OriginalBackupReceipt } from '../original-recording-backups'

// The receipt fixtures below model the authority contract only. No device transfer happens here;
// the real receipt store and SQLite are covered by their own tests.
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('hidock-backup-preflight-')) throw Error('Unsafe fixture cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const DEVICE_ID = sha('serial-A')

function fixture(count = 2) {
  const folder = mkdtempSync(join(tmpdir(), 'hidock-backup-preflight-')); folders.push(folder)
  const rows: DeviceBackupLocalRow[] = [], receipts = new Map<string, OriginalBackupReceipt>()
  const catalog: DeviceFsCatalog = { complete: true, deviceId: DEVICE_ID, sessionId: 'session-1', files: [] }
  for (let n = 1; n <= count; n++) {
    const contents = `recording-${n}`, name = `REA${String(n).padStart(8, '0')}.wav`, path = join(folder, `source-${n}.bin`)
    writeFileSync(path, contents)
    catalog.files.push({ name, size: Buffer.byteLength(contents), signature: `sig-${n}`, modified: null })
    rows.push({ id: `rec-${n}`, original_filename: name, file_path: path, on_local: 1, location: 'both', deleted_at: null })
    receipts.set(`rec-${n}`, {
      recordingId: `rec-${n}`, receiptVersion: 1, originKind: 'host-download-v1', originalFilename: name, canonicalPath: path,
      totalBytes: Buffer.byteLength(contents), sha256: sha(contents), deviceIdSha256: DEVICE_ID, model: 'H1', firmware: '1.0',
      catalogSignatureMd5: null, acquiredAt: '2026-10-12T00:00:00.000Z'
    })
  }
  const state = { catalog, rows, receipts, roots: [{ name: 'fixture', path: folder }] }
  const deps: DeviceRecordingBackupPreflightDependencies = {
    getCompleteCatalog: async () => state.catalog,
    listLocalRows: async () => state.rows,
    getLatestReceipt: async id => state.receipts.get(id) ?? null,
    getTrustedBackupRoots: async () => state.roots,
    remainingAuthorityCapacity: async () => 1024,
    remainingDestinationBytes: async () => Number.MAX_SAFE_INTEGER
  }
  return { folder, state, deps }
}

const expectWholeFailure = (result: Awaited<ReturnType<typeof planDeviceRecordingBackupPreflight>>) => {
  expect(result.compatibility).toBe('incompatible')
  expect(result.executionReadiness).toBe('not-ready')
  expect(result.compatibilityEntries).toEqual([])
  expect(result.deviceMutationAuthorized).toBe(false)
}

describe('device recording backup preflight authority adapter', () => {
  it('takes no caller-provided inventory, path, root, hash or provenance argument', () => {
    expect(planDeviceRecordingBackupPreflight.length).toBe(1)
  })

  it('binds every catalog file structurally and reports the destination as the same non-empty catalog', async () => {
    const f = fixture(3)
    const result = await planDeviceRecordingBackupPreflight(f.deps)
    expect(result.compatibility).toBe('compatible')
    expect(result.executionReadiness).toBe('blocked-destination-collision')
    expect(result.destinationCollisions).toBe(3)
    expect(result.summary).toMatchObject({ entryCount: 3, checkedSourceCount: 3, rehashPerformed: true })
    expect(result.compatibilityEntries.map(entry => entry.filename)).toEqual(f.state.catalog.files.map(file => file.name))
    expect(result.compatibilityEntries[0]).toMatchObject({ recordingId: 'rec-1', sha256: sha('recording-1'), byteLength: Buffer.byteLength('recording-1') })
    expect(result.baselineEvidence).toBe('host-download-v1-receipts')
    expect(result.deviceMutationAuthorized).toBe(false)
    expect(result.diagnostics).toMatchObject({ catalogFileCount: 3, provenFileCount: 3 })
  })

  it('fails the whole batch when one catalog file has no receipt, without leaking paths or hashes', async () => {
    const f = fixture(3); f.state.receipts.delete('rec-2')
    const result = await planDeviceRecordingBackupPreflight(f.deps)
    expectWholeFailure(result)
    expect(result.incompatibilities).toContain('receipt-unavailable-or-invalid')
    expect(result.diagnostics).toMatchObject({ filesWithoutReceipt: 1, provenFileCount: 2 })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(f.folder)
    expect(serialized).not.toContain(sha('recording-1'))
  })

  it('fails when a catalog file has no eligible local row', async () => {
    const f = fixture(2); f.state.rows.pop()
    const result = await planDeviceRecordingBackupPreflight(f.deps)
    expectWholeFailure(result)
    expect(result.diagnostics.filesWithoutLocalRow).toBe(1)
  })

  it.each([
    ['deleted row', (row: DeviceBackupLocalRow) => { row.deleted_at = '2026-10-01T00:00:00.000Z' }],
    ['not on local', (row: DeviceBackupLocalRow) => { row.on_local = 0 }],
    ['device-only location', (row: DeviceBackupLocalRow) => { row.location = 'device-only' }],
    ['deleted location', (row: DeviceBackupLocalRow) => { row.location = 'deleted' }]
  ])('filters out a %s, so its catalog file fails the batch', async (_label, mutate) => {
    const f = fixture(2); mutate(f.state.rows[0])
    const result = await planDeviceRecordingBackupPreflight(f.deps)
    expectWholeFailure(result)
    expect(result.diagnostics).toMatchObject({ eligibleLocalRowCount: 1, filesWithoutLocalRow: 1 })
  })

  describe('duplicate aliases of one original filename', () => {
    const addAlias = (f: ReturnType<typeof fixture>, withReceipt: boolean) => {
      const original = f.state.rows[0]
      const aliasPath = join(f.folder, 'alias.bin'); writeFileSync(aliasPath, 'recording-1')
      f.state.rows.push({ ...original, id: 'rec-alias', file_path: aliasPath })
      if (withReceipt) f.state.receipts.set('rec-alias', { ...f.state.receipts.get('rec-1')!, recordingId: 'rec-alias', canonicalPath: aliasPath })
    }
    it('accepts an unreceipted alias when exactly one candidate holds a bound receipt', async () => {
      const f = fixture(2); addAlias(f, false)
      const result = await planDeviceRecordingBackupPreflight(f.deps)
      expect(result.compatibility).toBe('compatible')
      expect(result.compatibilityEntries.map(entry => entry.recordingId)).toEqual(['rec-1', 'rec-2'])
    })
    it('fails when two aliases both hold valid receipts', async () => {
      const f = fixture(2); addAlias(f, true)
      const result = await planDeviceRecordingBackupPreflight(f.deps)
      expectWholeFailure(result)
      expect(result.diagnostics.filesWithAmbiguousCandidates).toBe(1)
    })
    it('fails when no alias holds a receipt', async () => {
      const f = fixture(2); addAlias(f, false); f.state.receipts.delete('rec-1')
      expectWholeFailure(await planDeviceRecordingBackupPreflight(f.deps))
    })
  })

  describe('receipt terms', () => {
    const rejects = async (mutate: (receipt: OriginalBackupReceipt) => void) => {
      const f = fixture(2); mutate(f.state.receipts.get('rec-1')!)
      const result = await planDeviceRecordingBackupPreflight(f.deps)
      expectWholeFailure(result)
      return result
    }
    it('rejects a receipt from a different device serial', async () => {
      const result = await rejects(receipt => { receipt.deviceIdSha256 = sha('serial-B') })
      expect(result.diagnostics.filesWithMismatchedReceipt).toBe(1)
    })
    it('rejects a receipt without device identity (legacy shape)', () => rejects(receipt => { receipt.deviceIdSha256 = null }))
    it('rejects a forged owned-upload-v1 receipt even with device terms filled in', () => rejects(receipt => { receipt.originKind = 'owned-upload-v1' }))
    it('rejects a receipt missing model or firmware', () => rejects(receipt => { receipt.model = null }))
    it('rejects a different original filename', () => rejects(receipt => { receipt.originalFilename = 'REA99999999.wav' }))
    it('rejects a different size', () => rejects(receipt => { receipt.totalBytes += 1 }))
    it('rejects a different canonical path', () => rejects(receipt => { receipt.canonicalPath = join(dirname(receipt.canonicalPath), 'other.bin') }))
    it('rejects a different recording id', () => rejects(receipt => { receipt.recordingId = 'rec-other' }))
    it('rejects a malformed digest', () => rejects(receipt => { receipt.sha256 = 'zz' }))
    it('rejects a lookup that throws', async () => {
      const f = fixture(1); f.deps.getLatestReceipt = async () => { throw Error('db closed') }
      expectWholeFailure(await planDeviceRecordingBackupPreflight(f.deps))
    })
  })

  it('rejects a same-size tampered local source through the planner rehash', async () => {
    const f = fixture(2)
    writeFileSync(f.state.rows[1].file_path as string, 'recording-X')
    const result = await planDeviceRecordingBackupPreflight(f.deps)
    expectWholeFailure(result)
    expect(result.incompatibilities).toContain('local-source-unavailable-or-changed')
  })

  it('rejects sources outside the main-owned named roots', async () => {
    const f = fixture(1)
    const other = mkdtempSync(join(tmpdir(), 'hidock-backup-preflight-')); folders.push(other)
    f.state.roots = [{ name: 'elsewhere', path: other }]
    const result = await planDeviceRecordingBackupPreflight(f.deps)
    expectWholeFailure(result)
    expect(result.incompatibilities).toContain('local-source-outside-trusted-root')
  })

  it('fails closed on an incomplete, empty, malformed or failing catalog', async () => {
    for (const mutate of [
      (c: DeviceFsCatalog) => { c.complete = false },
      (c: DeviceFsCatalog) => { c.files = [] },
      (c: DeviceFsCatalog) => { c.deviceId = 'not-a-hash' },
      (c: DeviceFsCatalog) => { c.files[0].name = 'invalid.mp3' },
      (c: DeviceFsCatalog) => { c.files[0].size = 0 },
      (c: DeviceFsCatalog) => { c.files.push({ ...c.files[0], name: c.files[0].name.toLowerCase() }) }
    ]) {
      const f = fixture(1); mutate(f.state.catalog)
      expectWholeFailure(await planDeviceRecordingBackupPreflight(f.deps))
    }
    const f = fixture(1); f.deps.getCompleteCatalog = async () => { throw Error('device gone') }
    expectWholeFailure(await planDeviceRecordingBackupPreflight(f.deps))
  })

  it('fails closed on unknown or insufficient capacities and a failing row source', async () => {
    const authority = fixture(2); authority.deps.remainingAuthorityCapacity = async () => 1
    expect((await planDeviceRecordingBackupPreflight(authority.deps)).incompatibilities).toContain('authority-capacity-exhausted')
    const unknown = fixture(1); unknown.deps.remainingDestinationBytes = async () => Number.NaN
    expect((await planDeviceRecordingBackupPreflight(unknown.deps)).incompatibilities).toContain('destination-capacity-unavailable')
    const small = fixture(1); small.deps.remainingDestinationBytes = async () => 10
    expectWholeFailure(await planDeviceRecordingBackupPreflight(small.deps))
    const rows = fixture(1); rows.deps.listLocalRows = async () => { throw Error('db closed') }
    expectWholeFailure(await planDeviceRecordingBackupPreflight(rows.deps))
  })

  it('keeps original_filename exact: a lower-cased row name is not normalized into a match', async () => {
    const f = fixture(1)
    f.state.rows[0].original_filename = f.state.rows[0].original_filename!.toLowerCase()
    expectWholeFailure(await planDeviceRecordingBackupPreflight(f.deps))
  })
})
