/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { planWholeDeviceRecordingRestore } from '../device-recording-restore-plan'
import type { DeviceRecordingRestorePlanDependencies, TrustedOriginalBinding, TrustedOriginalReceipt, TrustedWholeBackupInventory } from '../device-recording-restore-plan'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('hidock-restore-plan-')) throw Error('Unsafe fixture cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})
function binding(folder: string, n: number, contents = `recording-${n}`): TrustedOriginalBinding {
  const sourcePath = join(folder, `source-${n}.bin`); writeFileSync(sourcePath, contents)
  return { recordingId: `recording-${n}`, filename: `REA${String(n).padStart(8, '0')}.wav`, sourcePath, byteLength: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex') }
}
function fixture(count = 1) {
  const folder = mkdtempSync(join(tmpdir(), 'hidock-restore-plan-')); folders.push(folder)
  const entries = Array.from({ length: count }, (_, index) => binding(folder, index + 1))
  const baseline: TrustedWholeBackupInventory = { provenance: 'trusted-original-baseline', entries }
  const localBackup: TrustedWholeBackupInventory = { provenance: 'trusted-local-backup', entries: entries.map(entry => ({ ...entry })) }
  const receipts = new Map<string, TrustedOriginalReceipt>(entries.map(entry => [entry.recordingId, { ...entry, immutable: true, provenance: 'independent-original-download' }]))
  const deps: DeviceRecordingRestorePlanDependencies = {
    getTrustedBackupRoots: async () => [{ name: 'temporary-fixture', path: folder }],
    remainingAuthorityCapacity: async () => 1024,
    remainingDestinationBytes: async () => Number.MAX_SAFE_INTEGER,
    listDestinationFilenames: async () => [],
    getTrustedOriginalReceipt: async id => receipts.get(id) ?? null
  }
  return { folder, entries, baseline, localBackup, receipts, deps }
}

describe('whole recording backup F11 compatibility planner', () => {
  it('plans 558 complete original entries against the 1024 RSTR2 authority ceiling without device actions', async () => {
    const f = fixture(558)
    const plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup })
    expect(plan.compatibility).toBe('compatible')
    expect(plan.executionReadiness).toBe('ready-on-empty-destination')
    expect(plan.compatibilityEntries).toEqual(f.entries)
    expect(plan.summary).toMatchObject({ rehashPerformed: true, checkedSourceCount: 558 })
    expect(plan.summary.reservedBytes).toBeGreaterThan(558 * 8 * 1024 * 1024)
  })
  it('rejects the entire batch if capacity cannot cover every prospective BEGIN', async () => {
    const f = fixture(2); f.deps.remainingAuthorityCapacity = async () => 1
    const plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup })
    expect(plan.compatibility).toBe('incompatible')
    expect(plan.incompatibilities).toContain('authority-capacity-exhausted')
    expect(plan.compatibilityEntries).toEqual([])
  })
  it.each(['invalid.mp3', 'x'.repeat(28) + '.wav', 'UPPER.WAV', 'zero.wav'])('rejects unsupported, long, case-invalid and zero-byte originals: %s', async value => {
    const f = fixture(); const item = f.entries[0]
    if (value === 'zero.wav') { item.filename = value; item.byteLength = 0 }
    else item.filename = value
    f.localBackup.entries = [{ ...item }]
    const plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup })
    expect(plan.compatibility).toBe('incompatible'); expect(plan.compatibilityEntries).toEqual([])
  })
  it('treats duplicate names and an existing destination filename as separate fail-closed concerns', async () => {
    const f = fixture(2); f.entries[1].filename = f.entries[0].filename; f.localBackup.entries = f.entries.map(entry => ({ ...entry }))
    let plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup })
    expect(plan.incompatibilities).toContain('duplicate-filename'); expect(plan.compatibilityEntries).toEqual([])
    const clean = fixture(); clean.deps.listDestinationFilenames = async () => [clean.entries[0].filename]
    plan = await planWholeDeviceRecordingRestore(clean.deps, { baseline: clean.baseline, localBackup: clean.localBackup })
    expect(plan.compatibility).toBe('compatible'); expect(plan.executionReadiness).toBe('blocked-destination-collision'); expect(plan.destinationCollisions).toBe(1)
  })
  it('rejects stale receipt binding and a same-size changed local source during bounded rehash', async () => {
    const f = fixture(); const entry = f.entries[0]
    f.receipts.set(entry.recordingId, { ...entry, immutable: true, provenance: 'owned-upload', byteLength: entry.byteLength + 1, sha256: 'a'.repeat(64) })
    let plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup, rehashLocalFiles: true })
    expect(plan.incompatibilities).toContain('receipt-binding-mismatch')
    f.receipts.set(entry.recordingId, { ...entry, immutable: true, provenance: 'owned-upload' })
    writeFileSync(entry.sourcePath, 'X'.repeat(entry.byteLength))
    plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup, rehashLocalFiles: true })
    expect(plan.incompatibilities).toContain('local-source-unavailable-or-changed')
    expect(plan.summary.checkedSourceCount).toBe(1)
  })
  it('defaults to a full source rehash and allows explicit structural-only compatibility without readiness', async () => {
    const changed = fixture(); const entry = changed.entries[0]
    writeFileSync(entry.sourcePath, 'X'.repeat(entry.byteLength))
    const changedPlan = await planWholeDeviceRecordingRestore(changed.deps, { baseline: changed.baseline, localBackup: changed.localBackup })
    expect(changedPlan.incompatibilities).toContain('local-source-unavailable-or-changed')
    expect(changedPlan.executionReadiness).toBe('not-ready')
    expect(changedPlan.compatibilityEntries).toEqual([])

    const missing = fixture(); rmSync(missing.entries[0].sourcePath)
    const missingPlan = await planWholeDeviceRecordingRestore(missing.deps, { baseline: missing.baseline, localBackup: missing.localBackup })
    expect(missingPlan.incompatibilities).toContain('local-source-unavailable-or-changed')
    expect(missingPlan.executionReadiness).toBe('not-ready')
    expect(missingPlan.compatibilityEntries).toEqual([])

    const unverified = fixture()
    const unverifiedPlan = await planWholeDeviceRecordingRestore(unverified.deps, {
      baseline: unverified.baseline, localBackup: unverified.localBackup, rehashLocalFiles: false
    })
    expect(unverifiedPlan.compatibility).toBe('compatible')
    expect(unverifiedPlan.executionReadiness).toBe('not-ready')
    expect(unverifiedPlan.incompatibilities).toContain('local-bytes-not-verified')
    expect(unverifiedPlan.compatibilityEntries).toEqual([])
  })
  it('fails closed when no main-process trusted source root is available', async () => {
    const f = fixture(); f.deps.getTrustedBackupRoots = async () => []
    const plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup })
    expect(plan.compatibility).toBe('incompatible')
    expect(plan.executionReadiness).toBe('not-ready')
    expect(plan.incompatibilities).toContain('source-root-unavailable-or-invalid')
    expect(plan.compatibilityEntries).toEqual([])
  })
  it('accepts files under separately named roots explicitly supplied by the main-process authority', async () => {
    const f = fixture(), entry = f.entries[0]
    const archive = mkdtempSync(join(tmpdir(), 'hidock-restore-plan-archive-')); folders.push(archive)
    const archivePath = join(archive, 'source-1.bin'); writeFileSync(archivePath, 'recording-1')
    entry.sourcePath = archivePath
    f.localBackup.entries[0].sourcePath = archivePath
    f.receipts.set(entry.recordingId, { ...entry, immutable: true, provenance: 'owned-upload' })
    f.deps.getTrustedBackupRoots = async () => [
      { name: 'temporary-fixture', path: f.folder }, { name: 'approved-owned-archive', path: archive }
    ]
    const plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup })
    expect(plan.compatibility).toBe('compatible')
    expect(plan.executionReadiness).toBe('ready-on-empty-destination')
    expect(plan.compatibilityEntries).toEqual([entry])
  })
  it('rejects a source outside every trusted root and a junction that escapes a trusted root', async () => {
    const outside = fixture(), outsideDir = mkdtempSync(join(tmpdir(), 'hidock-restore-plan-outside-')); folders.push(outsideDir)
    const outsidePath = join(outsideDir, 'source-1.bin'); writeFileSync(outsidePath, 'recording-1')
    outside.entries[0].sourcePath = outsidePath
    outside.localBackup.entries[0].sourcePath = outsidePath
    outside.receipts.set('recording-1', { ...outside.entries[0], immutable: true, provenance: 'independent-original-download' })
    let plan = await planWholeDeviceRecordingRestore(outside.deps, { baseline: outside.baseline, localBackup: outside.localBackup })
    expect(plan.incompatibilities).toContain('local-source-outside-trusted-root')
    expect(plan.compatibilityEntries).toEqual([])

    const escaped = fixture(), escapeDir = mkdtempSync(join(tmpdir(), 'hidock-restore-plan-escape-')); folders.push(escapeDir)
    writeFileSync(join(escapeDir, 'source-1.bin'), 'recording-1')
    const junction = join(escaped.folder, 'escape')
    symlinkSync(escapeDir, junction, process.platform === 'win32' ? 'junction' : 'dir')
    const escapedPath = join(junction, 'source-1.bin')
    escaped.entries[0].sourcePath = escapedPath
    escaped.localBackup.entries[0].sourcePath = escapedPath
    escaped.receipts.set('recording-1', { ...escaped.entries[0], immutable: true, provenance: 'independent-original-download' })
    plan = await planWholeDeviceRecordingRestore(escaped.deps, { baseline: escaped.baseline, localBackup: escaped.localBackup })
    expect(plan.incompatibilities).toContain('local-source-outside-trusted-root')
    expect(plan.compatibilityEntries).toEqual([])
  })
  it('requires exact baseline/local completeness and fails unknown capacity or receipt evidence', async () => {
    const f = fixture(2); f.localBackup.entries = [f.localBackup.entries[0]]; f.deps.remainingAuthorityCapacity = async () => { throw Error('unknown') }
    const plan = await planWholeDeviceRecordingRestore(f.deps, { baseline: f.baseline, localBackup: f.localBackup })
    expect(plan.incompatibilities).toContain('inventory-mismatch')
    expect(plan.incompatibilities).toContain('authority-capacity-unavailable')
    expect(plan.compatibilityEntries).toEqual([])
  })
})
