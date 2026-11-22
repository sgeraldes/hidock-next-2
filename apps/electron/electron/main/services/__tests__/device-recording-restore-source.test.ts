/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createDeviceRecordingRestoreSourceResolver } from '../device-recording-restore-source'
import type { DeviceRecordingRestoreLibraryRow } from '../device-recording-restore-source'
import type { OriginalBackupReceipt } from '../original-recording-backups'
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('hidock-restore-source-')) throw Error('Unsafe fixture cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})
const FIXTURE_BYTES = 'owned-test-fixture'
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function receiptFor(path: string, originalFilename: string, recordingId = 'library-id'): OriginalBackupReceipt {
  return { recordingId, receiptVersion: 1, originKind: 'host-download-v1', originalFilename, canonicalPath: realpathSync.native(path),
    totalBytes: Buffer.byteLength(FIXTURE_BYTES), sha256: sha(FIXTURE_BYTES), deviceIdSha256: 'a'.repeat(64), model: 'hidock-h1e',
    firmware: '393988:6.3.4', catalogSignatureMd5: null, acquiredAt: '2026-10-12T00:00:00.000Z' }
}
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'hidock-restore-source-')); folders.push(folder)
  const root = join(folder, 'Recordings'), sibling = join(folder, 'Recordings-other'); mkdirSync(root); mkdirSync(sibling)
  const path = join(root, 'local-transformed-storage.wav'); writeFileSync(path, FIXTURE_BYTES)
  const row: DeviceRecordingRestoreLibraryRow = { id: 'library-id', filename: 'original.wav', file_path: path, on_local: 1, location: 'local-only', deleted_at: null }
  const state = { receipt: receiptFor(path, 'original.wav') as OriginalBackupReceipt | null }
  const deps = { getRecordingById: vi.fn(async (id: string) => id === row.id ? row : undefined), getRecordingsPath: vi.fn(() => root),
    getOriginalBackup: vi.fn(async (id: string) => id === row.id ? state.receipt : null) }
  return { folder, root, sibling, path, row, state, deps, resolver: createDeviceRecordingRestoreSourceResolver(deps) }
}
describe('trusted restore source: stored original-backup receipt bound to a contained regular file', () => {
  it('returns the receipt name and host digest, never the storage basename, and does not rehash the file', async () => {
    const f = fixture()
    expect(await f.resolver('library-id')).toEqual({ path: realpathSync.native(f.path), filename: 'original.wav', sha256: sha(FIXTURE_BYTES), totalBytes: 18 })
    expect(f.deps.getOriginalBackup).toHaveBeenCalledWith('library-id')
  })
  it('captured device name is restored even when the local file was renamed on a collision', async () => {
    const f = fixture(), collided = join(f.root, '2026Oct12-111955-Rec83-1.wav'); renameSync(f.path, collided)
    f.row.file_path = collided; f.row.filename = '2026Oct12-111955-Rec83-1.wav'; f.row.original_filename = '2026Oct12-111955-Rec83.hda'
    f.state.receipt = receiptFor(collided, '2026Oct12-111955-Rec83.hda')
    expect(await f.resolver('library-id')).toMatchObject({ path: realpathSync.native(collided), filename: '2026Oct12-111955-Rec83.hda' })
  })
  it('an empty original_filename on the row is not a change, a different populated one is', async () => {
    const f = fixture(); f.row.original_filename = ''
    expect((await f.resolver('library-id'))?.filename).toBe('original.wav')
    f.row.original_filename = 'original.wav'; expect((await f.resolver('library-id'))?.filename).toBe('original.wav')
    f.row.original_filename = 'other-name.wav'; expect(await f.resolver('library-id')).toBeNull()
    f.row.original_filename = '../foreign.wav'; expect(await f.resolver('library-id')).toBeNull()
  })
  it.each([
    ['renderer-supplied name', 'renderer-picked.wav'], ['direct save', 'direct-save.wav'], ['split child inherited name', 'parent-split.hda'],
    ['imported name', 'imported.wav'], ['legacy download row', 'legacy-device.hda']
  ])('rejects an unreceipted recording (%s) even though original_filename and filename look valid', async (_kind, name) => {
    const f = fixture(); f.state.receipt = null; f.row.filename = name; f.row.original_filename = name
    expect(await f.resolver('library-id')).toBeNull()
    f.deps.getOriginalBackup.mockResolvedValueOnce(null); expect(await f.resolver('library-id')).toBeNull()
  })
  it('rejects when the dependency cannot supply receipts at all', async () => {
    const f = fixture(), resolver = createDeviceRecordingRestoreSourceResolver({ getRecordingById: f.deps.getRecordingById, getRecordingsPath: f.deps.getRecordingsPath })
    expect(await resolver('library-id')).toBeNull()
  })
  it.each([
    ['another recording id', (f: ReturnType<typeof fixture>) => { f.state.receipt = receiptFor(f.path, 'original.wav', 'other-id') }],
    ['malformed digest', (f: ReturnType<typeof fixture>) => { f.state.receipt = { ...f.state.receipt!, sha256: 'ABC' } }],
    ['uppercase digest', (f: ReturnType<typeof fixture>) => { f.state.receipt = { ...f.state.receipt!, sha256: 'A'.repeat(64) } }],
    ['negative length', (f: ReturnType<typeof fixture>) => { f.state.receipt = { ...f.state.receipt!, totalBytes: -1 } }],
    ['invalid receipt name', (f: ReturnType<typeof fixture>) => { f.state.receipt = { ...f.state.receipt!, originalFilename: '../x.wav' } }]
  ])('rejects a receipt with %s', async (_kind, mutate) => {
    const f = fixture(); mutate(f); expect(await f.resolver('library-id')).toBeNull()
  })
  it('rejects a changed path: the file moved inside the root or the row now points elsewhere', async () => {
    const f = fixture(), moved = join(f.root, 'moved.wav'); renameSync(f.path, moved); f.row.file_path = moved
    expect(await f.resolver('library-id')).toBeNull()
  })
  it('rejects a changed length', async () => {
    const f = fixture(); writeFileSync(f.path, `${FIXTURE_BYTES}-and-more`); expect(await f.resolver('library-id')).toBeNull()
  })
  it('a same-length local edit still resolves here: the digest comparison belongs to the restore service at BEGIN', async () => {
    const f = fixture(); writeFileSync(f.path, FIXTURE_BYTES.toUpperCase())
    expect((await f.resolver('library-id'))?.sha256).toBe(sha(FIXTURE_BYTES))
  })
  it.each(['on_local', 'device-only', 'deleted', 'tombstone', 'null-path', 'relative-path', 'missing-file', 'directory', 'wrong-id'])('rejects ineligible source %s', async kind => {
    const f = fixture()
    if (kind === 'on_local') f.row.on_local = 0
    if (kind === 'device-only') f.row.location = 'device-only'
    if (kind === 'deleted') f.row.location = 'deleted'
    if (kind === 'tombstone') f.row.deleted_at = '2026-01-01'
    if (kind === 'null-path') f.row.file_path = null
    if (kind === 'relative-path') f.row.file_path = 'relative.wav'
    if (kind === 'missing-file') f.row.file_path = join(f.root, 'missing.wav')
    if (kind === 'directory') f.row.file_path = f.root
    if (kind === 'wrong-id') f.deps.getRecordingById.mockResolvedValueOnce({ ...f.row, id: 'other-library-id' })
    expect(await f.resolver('library-id')).toBeNull()
  })
  it.each(['../file.wav', 'bad/thing.wav', 'UPPER.WAV', 'x'.repeat(28), 'normal.mp3', 'é.wav'])('rejects unsupported captured name %s', async filename => {
    const f = fixture(); f.state.receipt = { ...f.state.receipt!, originalFilename: filename }
    expect(await f.resolver('library-id')).toBeNull()
  })
  it('rejects lexical sibling-prefix and parent traversal escape', async () => {
    const f = fixture(), other = join(f.sibling, 'foreign.wav'); writeFileSync(other, FIXTURE_BYTES)
    f.state.receipt = receiptFor(other, 'original.wav')
    f.row.file_path = other; expect(await f.resolver('library-id')).toBeNull()
    f.row.file_path = join(f.root, '..', 'Recordings-other', 'foreign.wav'); expect(await f.resolver('library-id')).toBeNull()
  })
  it('rejects an escaping directory junction even when lexical source lies inside root', async () => {
    const f = fixture(), target = join(f.sibling, 'foreign.wav'); writeFileSync(target, FIXTURE_BYTES)
    f.state.receipt = receiptFor(target, 'original.wav')
    const link = join(f.root, 'external'); symlinkSync(f.sibling, link, process.platform === 'win32' ? 'junction' : 'dir')
    f.row.file_path = join(link, 'foreign.wav'); expect(await f.resolver('library-id')).toBeNull()
  })
  it('accepts an inside-root directory junction while returning canonical contained path', async () => {
    const f = fixture(), target = join(f.root, 'contained'); mkdirSync(target); writeFileSync(join(target, 'test.wav'), FIXTURE_BYTES)
    f.state.receipt = receiptFor(join(target, 'test.wav'), 'original.wav')
    const link = join(f.root, 'alias'); symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    f.row.file_path = join(link, 'test.wav')
    expect(await f.resolver('library-id')).toMatchObject({ path: realpathSync.native(join(target, 'test.wav')), filename: 'original.wav' })
  })
  it('rejects a final file symlink even if its target stays inside configured root', async context => {
    const f = fixture(), link = join(f.root, 'file-link.wav')
    try { symlinkSync(f.path, link, 'file') } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return }
      throw error
    }
    f.row.file_path = link; expect(await f.resolver('library-id')).toBeNull()
  })
  it.runIf(process.platform === 'win32')('uses Windows case-insensitive lexical/canonical containment on actual filesystem', async () => {
    const f = fixture(); f.row.file_path = f.path.toUpperCase(); f.deps.getRecordingsPath.mockReturnValue(f.root.toLowerCase())
    expect((await f.resolver('library-id'))?.filename).toBe('original.wav')
  })
  it('rejects storage configuration changing during async resolver work and hides errors', async () => {
    const f = fixture(); f.deps.getRecordingsPath.mockReturnValueOnce(f.root).mockReturnValue(f.sibling)
    expect(await f.resolver('library-id')).toBeNull()
    f.deps.getRecordingById.mockRejectedValueOnce(Error('PRIVATE-PATH-DETAIL'))
    expect(await f.resolver('library-id')).toBeNull()
    f.deps.getOriginalBackup.mockRejectedValueOnce(Error('PRIVATE-PATH-DETAIL'))
    expect(await f.resolver('library-id')).toBeNull()
  })
})
