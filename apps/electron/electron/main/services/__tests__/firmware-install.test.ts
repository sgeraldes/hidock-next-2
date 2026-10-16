// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ACCEPTED_H1E_FIRMWARE, ACCEPTED_H1E_FORWARD_STOCK_RESTORE, parseFirmwareImage } from '@hidock/jensen-protocol'
import { FirmwareInstallJournal } from '../firmware-install-journal'
import { FirmwareInstallService, VAD_H1E_FIRMWARE } from '../firmware-install'

// The signed firmware images are pinned by sha256 and cannot be synthesized, and they are kept
// out of this public repo on purpose (.gitignore; decided 16-oct-2026): they live only on the
// owner's disk. A test that calls prepare() on one of these paths reads the real file, so it is
// skipped here with a clear reason when the image is absent; tests that reject before any file
// read, or that build their own synthetic image, still run.
const HARDENED_IMAGE = resolve('resources/firmware/h1e-rea-hardened.bin')
const FORWARD_STOCK_IMAGE = resolve('resources/firmware/h1e-stock-forward.bin')
const VAD_IMAGE = resolve('../../research/rea/completion630-lab/hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/out-NOTINSTALL/compose-3/H1E-6.3.8_vad001-EXPERIMENTAL-NOT-INSTALL.bin')
const noHardened = !existsSync(HARDENED_IMAGE)
const noForwardStock = !existsSync(FORWARD_STOCK_IMAGE)
// prepare()/execute() read the pinned image only after the qualification, stock-recovery, fence
// and idle guards pass, so tests that assert a rejection before that read still run; the ones
// below reach the real read and are skipped when the image is absent.
const itHardened = noHardened ? it.skip : it
const itForwardStock = noHardened || noForwardStock ? it.skip : it

const folders: string[] = []
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })))
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'hidock-firmware-contract-')); folders.push(folder)
  const journal = new FirmwareInstallJournal(join(folder, 'journal'))
  const device: any = {
    firmwareRecoveryReadOnly: false,
    getDeviceInfo: vi.fn(async () => ({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393984, versionCode: '6.3.0' })),
    getFirmwareUpdatePreflight: vi.fn(async () => ({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393984, activeRecording: false, card: { freeMiB: 2000, capacityMiB: 32000, statusCode: 0x900 } })),
    isConnected: () => true, tryConnect: vi.fn(),
    uploadFirmware: vi.fn(async () => ({ status: 'uploaded', reason: 'transfer-acknowledged', installation: 'unverified' })),
    verifyFirmwareUpdateBoot: vi.fn(async () => ({ status: 'confirmed', reason: 'readbacks', imageAttested: false })),
  }
  let time = 1000000, busy = false
  const fence = vi.fn(async (): Promise<boolean> => false)
  const deps = { device: () => device, journal, artifactPath: HARDENED_IMAGE, idle: () => !busy, qualificationEnabled: true,
    hasUnresolvedStorageOwnership: fence,
    serialize: async <T>(fn: () => Promise<T>) => fn(), now: () => time, sleep: async (ms: number) => { time += ms } }
  return { folder, journal, device, deps, fence, service: new FirmwareInstallService(deps), advance: (ms: number) => { time += ms }, busy: () => { busy = true } }
}
function vadFixture() {
  const f = fixture(), serialNumber = 'PRIVATE-TEST-DOCK'
  f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber, versionNumber: 393990, versionCode: '6.3.6' })
  f.device.getFirmwareUpdatePreflight.mockResolvedValue({ model: 'hidock-h1e', serialNumber, versionNumber: 393990, activeRecording: false, card: { freeMiB: 2000, capacityMiB: 32000, statusCode: 0x900 } })
  const service = new FirmwareInstallService({ ...f.deps, vadArtifactPath: VAD_IMAGE })
  return { ...f, service }
}
describe(`firmware owner preparation and durable real-file attempt boundary${noHardened ? ' (image-reading tests skipped: local-only firmware image not in the public repo)' : ''}`, () => {
  itForwardStock('prepares exact forward resource only from the new custom source, then confirms native stock boot', async () => {
    const f = fixture()
    const service = new FirmwareInstallService({ ...f.deps, stockRecoveryEnabled: true, forwardStockArtifactPath: FORWARD_STOCK_IMAGE })
    await expect(service.prepare('stock-forward')).rejects.toThrow('does not permit')
    f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393985, versionCode: '6.3.1' })
    await expect(service.prepare('stock-forward')).rejects.toThrow('does not permit')
    f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393988, versionCode: '6.3.4' })
    f.device.getFirmwareUpdatePreflight.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393988, activeRecording: false, card: { freeMiB: 2000, capacityMiB: 32000, statusCode: 0x900 } })
    const plan = await service.prepare('stock-forward')
    expect(plan.plan).toMatchObject({ targetVersion: 393989, sourceVersion: 393988, imageSha256: ACCEPTED_H1E_FORWARD_STOCK_RESTORE.sha256, imageBytes: ACCEPTED_H1E_FORWARD_STOCK_RESTORE.bytes })
    expect((await service.execute(plan.plan.id, plan.plan.imageSha256)).state).toBe('awaiting-boot')
    expect(f.device.uploadFirmware).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 393989 }), expect.objectContaining({ allowDowngrade: false }))
    f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393989, versionCode: '6.3.5' })
    expect((await service.observe(plan.plan.id, 0)).state).toBe('confirmed')
    expect(f.device.verifyFirmwareUpdateBoot).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 393989, sourceVersionNumber: 393988, customRecording: false }), 3)
  })
  itHardened('permits only the explicitly selected pinned return from known forward stock', async () => {
    const f = fixture()
    f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393989, versionCode: '6.3.5' })
    f.device.getFirmwareUpdatePreflight.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393989, activeRecording: false, card: { freeMiB: 2000, capacityMiB: 32000, statusCode: 0x900 } })
    const plan = await f.service.prepare('hardened')
    expect((await f.service.execute(plan.plan.id, plan.plan.imageSha256)).state).toBe('awaiting-boot')
    expect(f.device.uploadFirmware).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 393988 }), expect.objectContaining({ allowDowngrade: true }))
    const wrong = fixture()
    wrong.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393989, versionCode: '6.3.4' })
    await expect(wrong.service.prepare('hardened')).rejects.toThrow('does not permit')
    expect(wrong.device.uploadFirmware).not.toHaveBeenCalled()
  })
  itHardened('reads actual selected image and prepares without upload or raw identity persistence', async () => {
    const f = fixture(), attempt = await f.service.prepare()
    expect(attempt.plan).toMatchObject({ imageSha256: ACCEPTED_H1E_FIRMWARE.sha256, imageBytes: ACCEPTED_H1E_FIRMWARE.bytes, sourceVersion: 393984, targetVersion: ACCEPTED_H1E_FIRMWARE.versionNumber })
    const persisted = readFileSync(join(f.journal.folder, attempt.plan.id, 'plan.json'), 'utf8')
    expect(persisted).not.toContain('PRIVATE-TEST-DOCK')
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
    expect(new FirmwareInstallJournal(f.journal.folder).read(attempt.plan.id)).toEqual(attempt)
  })
  itHardened('fsynced requesting record exists before upload; restart blocks another preparation and never retries', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    f.device.uploadFirmware.mockImplementationOnce(async () => {
      expect(new FirmwareInstallJournal(f.journal.folder).pending()[0].state).toBe('requesting')
      throw new Error('host stopped after uncertain request')
    })
    expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('uncertain')
    const restarted = new FirmwareInstallService({ ...f.deps, journal: new FirmwareInstallJournal(f.journal.folder) })
    await expect(restarted.prepare()).rejects.toThrow('unresolved')
    await expect(restarted.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('unresolved')
    expect((await restarted.observe(prepared.plan.id, 0)).state).toBe('uncertain')
    expect(f.device.uploadFirmware).toHaveBeenCalledTimes(1)
    expect(f.device.firmwareRecoveryReadOnly).toBe(true)
  })
  itHardened('wrong digest, expiry, busy owner, changed identity and corrupted image never upload', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await expect(f.service.execute(prepared.plan.id, '0'.repeat(64))).rejects.toThrow()
    f.device.getDeviceInfo.mockResolvedValueOnce({ model: 'hidock-h1e', serialNumber: 'OTHER-DOCK', versionNumber: 393984, versionCode: '6.3.0' })
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('changed')
    f.advance(300001)
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('expired')
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
    const second = fixture(); second.busy(); await expect(second.service.prepare()).rejects.toThrow('busy')
    const corrupt = join(second.folder, 'bad.bin'); writeFileSync(corrupt, new Uint8Array(512))
    await expect(new FirmwareInstallService({ ...second.deps, idle: () => true, artifactPath: corrupt }).prepare()).rejects.toThrow('pin')
  })
  itHardened('known native rejection closes attempt without retry or lingering journal fence', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    f.device.uploadFirmware.mockResolvedValueOnce({ status: 'rejected', reason: 'busy' })
    expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('rejected')
    expect(f.journal.pending()).toEqual([])
    expect(f.device.firmwareRecoveryReadOnly).toBe(false)
  })
  itHardened('maintenance launch can prepare but cannot execute or clear its read-only guard', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    f.device.firmwareRecoveryReadOnly = true
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('read-only')
    expect(f.journal.read(prepared.plan.id).state).toBe('prepared')
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
    expect(f.device.firmwareRecoveryReadOnly).toBe(true)
  })
  itHardened('maintenance dependency refuses execution even if a caller clears the device property', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    const maintenance = new FirmwareInstallService({ ...f.deps, maintenanceReadOnly: true })
    await expect(maintenance.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('read-only')
    expect(f.journal.read(prepared.plan.id).state).toBe('prepared')
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
  })
  itHardened('device validation refuses before durable requesting or any upload invocation', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    f.device.deviceValidationReadOnly = true
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('read-only')
    expect(f.journal.read(prepared.plan.id)).toMatchObject({ state: 'prepared', events: [expect.anything()] })
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
  })
  itHardened('successful read-only boot observation keeps the launch maintenance guard', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)
    f.device.getDeviceInfo.mockResolvedValueOnce({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: ACCEPTED_H1E_FIRMWARE.versionNumber, versionCode: '6.3.4' })
    const maintenance = new FirmwareInstallService({ ...f.deps, maintenanceReadOnly: true })
    expect((await maintenance.observe(prepared.plan.id, 0)).state).toBe('confirmed')
    expect(f.device.firmwareRecoveryReadOnly).toBe(true)
  })
  itHardened('requires exact postboot identity/version and native capability confirmation', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('awaiting-boot')
    f.device.getDeviceInfo.mockResolvedValueOnce({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393989, versionCode: '6.3.5' })
    expect((await f.service.observe(prepared.plan.id, 0)).state).toBe('uncertain')
    expect(f.device.verifyFirmwareUpdateBoot).not.toHaveBeenCalled()
    f.device.getDeviceInfo.mockResolvedValueOnce({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: ACCEPTED_H1E_FIRMWARE.versionNumber, versionCode: '6.3.4' })
    expect((await f.service.observe(prepared.plan.id, 0)).state).toBe('confirmed')
    expect(f.device.verifyFirmwareUpdateBoot).toHaveBeenCalledWith(expect.objectContaining({ sourceVersionNumber: 393984, versionNumber: ACCEPTED_H1E_FIRMWARE.versionNumber, customRecording: true }), 3)
    expect(f.device.firmwareRecoveryReadOnly).toBe(false)
  })
  itHardened('torn journal fails closed instead of inferring upload success or forgetting uncertainty', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    writeFileSync(join(f.journal.folder, prepared.plan.id, 'event-0001.json'), '{"state":"requesting"')
    expect(() => new FirmwareInstallJournal(f.journal.folder).pending()).toThrow()
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow()
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
  })
  describe('fail-closed policy flags (zero device I/O)', () => {
    const noDeviceIo = (f: ReturnType<typeof fixture>) => {
      expect(f.device.getDeviceInfo).not.toHaveBeenCalled()
      expect(f.device.getFirmwareUpdatePreflight).not.toHaveBeenCalled()
      expect(f.device.uploadFirmware).not.toHaveBeenCalled()
      expect(f.device.verifyFirmwareUpdateBoot).not.toHaveBeenCalled()
      expect(f.device.tryConnect).not.toHaveBeenCalled()
    }
    const stockSetup = (f: ReturnType<typeof fixture>) => {
      f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393988, versionCode: '6.3.4' })
      f.device.getFirmwareUpdatePreflight.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393988, activeRecording: false, card: { freeMiB: 2000, capacityMiB: 32000, statusCode: 0x900 } })
      return { ...f.deps, stockRecoveryEnabled: true, forwardStockArtifactPath: FORWARD_STOCK_IMAGE }
    }
    it('absent qualificationEnabled (normal app) rejects prepare and execute before any I/O', async () => {
      const f = fixture(), { qualificationEnabled: _omitted, ...normal } = f.deps
      const service = new FirmwareInstallService(normal)
      await expect(service.prepare()).rejects.toThrow('qualification is not enabled')
      await expect(service.prepare('stock-forward')).rejects.toThrow('qualification is not enabled')
      await expect(service.execute('any-id', 'a'.repeat(64))).rejects.toThrow('qualification is not enabled')
      noDeviceIo(f)
      expect(f.journal.all()).toEqual([])
    })
    it('explicit qualificationEnabled false rejects before I/O', async () => {
      const f = fixture(), service = new FirmwareInstallService({ ...f.deps, qualificationEnabled: false })
      await expect(service.prepare()).rejects.toThrow('qualification is not enabled')
      noDeviceIo(f)
    })
    it('stock-forward without stockRecoveryEnabled is rejected at prepare before any I/O', async () => {
      const f = fixture(), service = new FirmwareInstallService({ ...f.deps, forwardStockArtifactPath: FORWARD_STOCK_IMAGE })
      await expect(service.prepare('stock-forward')).rejects.toThrow('Stock-forward firmware recovery is not enabled')
      await expect(new FirmwareInstallService({ ...f.deps, stockRecoveryEnabled: false }).prepare('stock-forward')).rejects.toThrow('Stock-forward firmware recovery is not enabled')
      noDeviceIo(f)
      expect(f.journal.all()).toEqual([])
    })
    itHardened('stock recovery flag does not weaken the hardened path or qualification requirement', async () => {
      const f = fixture(), { qualificationEnabled: _omitted, ...normal } = f.deps
      await expect(new FirmwareInstallService({ ...normal, stockRecoveryEnabled: true }).prepare('stock-forward')).rejects.toThrow('qualification is not enabled')
      noDeviceIo(f)
      expect((await new FirmwareInstallService(f.deps).prepare()).state).toBe('prepared')
    })
    itHardened('prepared token is refused when qualification is later off, with no execute-time I/O', async () => {
      const f = fixture(), prepared = await f.service.prepare()
      f.device.getDeviceInfo.mockClear(); f.device.getFirmwareUpdatePreflight.mockClear()
      const later = new FirmwareInstallService({ ...f.deps, qualificationEnabled: false })
      await expect(later.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('qualification is not enabled')
      noDeviceIo(f)
      expect(f.journal.read(prepared.plan.id).state).toBe('prepared')
    })
    itForwardStock('saved stock-forward token is refused at execute when stock recovery is no longer enabled', async () => {
      const f = fixture(), plan = await new FirmwareInstallService(stockSetup(f)).prepare('stock-forward')
      f.device.getDeviceInfo.mockClear(); f.device.getFirmwareUpdatePreflight.mockClear()
      const later = new FirmwareInstallService({ ...f.deps, forwardStockArtifactPath: FORWARD_STOCK_IMAGE })
      await expect(later.execute(plan.plan.id, plan.plan.imageSha256)).rejects.toThrow('Stock-forward firmware recovery is not enabled')
      noDeviceIo(f)
      expect(f.journal.read(plan.plan.id)).toMatchObject({ state: 'prepared', events: [expect.anything()] })
    })
    itHardened('hardened saved token still executes when stock recovery is off', async () => {
      const f = fixture(), prepared = await f.service.prepare()
      expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('awaiting-boot')
      expect(f.device.uploadFirmware).toHaveBeenCalledOnce()
    })
    itHardened('expired or unresolved prepared token under disabled policy still rejects without I/O or journal change', async () => {
      const f = fixture(), prepared = await f.service.prepare()
      f.advance(300001); f.device.getDeviceInfo.mockClear(); f.device.getFirmwareUpdatePreflight.mockClear()
      const off = new FirmwareInstallService({ ...f.deps, qualificationEnabled: false })
      await expect(off.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('qualification is not enabled')
      noDeviceIo(f)
      expect(f.journal.read(prepared.plan.id).state).toBe('prepared')
    })
    itHardened('status and observe stay usable for an unresolved attempt when qualification is off, and never upload', async () => {
      const f = fixture(), prepared = await f.service.prepare()
      await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)
      const off = new FirmwareInstallService({ ...f.deps, qualificationEnabled: false, maintenanceReadOnly: true })
      expect(off.status().map(attempt => attempt.plan.id)).toEqual([prepared.plan.id])
      f.device.getDeviceInfo.mockResolvedValueOnce({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: ACCEPTED_H1E_FIRMWARE.versionNumber, versionCode: '6.3.4' })
      expect((await off.observe(prepared.plan.id, 0)).state).toBe('confirmed')
      expect(f.device.uploadFirmware).toHaveBeenCalledTimes(1)
      await expect(off.prepare()).rejects.toThrow('qualification is not enabled')
    })
  })
  describe('durable storage-ownership fence (real temporary journals, injected device methods)', () => {
    type Fixture = ReturnType<typeof fixture>
    const OWNERSHIP = 'Storage write ownership is unresolved or unavailable'
    const native = (f: Fixture) => ({
      info: f.device.getDeviceInfo.mock.calls.length, preflight: f.device.getFirmwareUpdatePreflight.mock.calls.length,
      upload: f.device.uploadFirmware.mock.calls.length, verify: f.device.verifyFirmwareUpdateBoot.mock.calls.length,
      connect: f.device.tryConnect.mock.calls.length,
    })
    const ZERO = { info: 0, preflight: 0, upload: 0, verify: 0, connect: 0 }
    const withoutFence = (f: Fixture, extra: object = {}) => {
      const { hasUnresolvedStorageOwnership: _omitted, ...rest } = f.deps
      return new FirmwareInstallService({ ...rest, ...extra })
    }
    const clearNative = (f: Fixture) => {
      f.device.getDeviceInfo.mockClear(); f.device.getFirmwareUpdatePreflight.mockClear()
      f.device.uploadFirmware.mockClear(); f.device.verifyFirmwareUpdateBoot.mockClear(); f.device.tryConnect.mockClear()
      f.fence.mockClear()
    }
    const failing: Array<[string, (f: Fixture) => FirmwareInstallService]> = [
      ['callback absent', f => withoutFence(f)],
      ['callback throws', f => { f.fence.mockRejectedValue(new Error('journal unreadable')); return f.service }],
      ['callback reports unresolved', f => { f.fence.mockResolvedValue(true); return f.service }],
      ['callback returns a non-boolean', f => { f.fence.mockResolvedValue(undefined as unknown as boolean); return f.service }],
    ]
    it.each(failing)('%s: prepare rejects before any device I/O and creates no attempt', async (_name, build) => {
      const f = fixture(), service = build(f)
      await expect(service.prepare()).rejects.toThrow(OWNERSHIP)
      expect(native(f)).toEqual(ZERO)
      expect(f.journal.all()).toEqual([])
    })
    itHardened.each(failing)('%s: execute of a prepared token rejects before any device I/O and leaves the journal unchanged', async (_name, build) => {
      const f = fixture(), prepared = await f.service.prepare(), before = f.journal.read(prepared.plan.id)
      clearNative(f)
      const service = build(f)
      await expect(service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow(OWNERSHIP)
      expect(native(f)).toEqual(ZERO)
      expect(f.journal.read(prepared.plan.id)).toEqual(before)
    })
    it('unresolved fence refuses the stock-forward target before any device I/O', async () => {
      const f = fixture(); f.fence.mockResolvedValue(true)
      const service = new FirmwareInstallService({ ...f.deps, stockRecoveryEnabled: true, forwardStockArtifactPath: FORWARD_STOCK_IMAGE })
      await expect(service.prepare('stock-forward')).rejects.toThrow(OWNERSHIP)
      expect(native(f)).toEqual(ZERO)
      expect(f.journal.all()).toEqual([])
    })
    itHardened.each([
      ['reports unresolved', (f: Fixture) => f.fence.mockResolvedValueOnce(false).mockResolvedValueOnce(true)],
      ['throws', (f: Fixture) => f.fence.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('journal unreadable'))],
    ])('fence that %s after native preflight prevents attempt creation', async (_name, arrange) => {
      const f = fixture(); arrange(f)
      await expect(f.service.prepare()).rejects.toThrow(OWNERSHIP)
      expect(native(f)).toEqual({ ...ZERO, info: 1, preflight: 1 })
      expect(f.fence).toHaveBeenCalledTimes(2)
      expect(f.journal.all()).toEqual([])
    })
    itHardened('paused restore appearing after the token was prepared prevents execute and leaves the journal unchanged', async () => {
      const f = fixture(), prepared = await f.service.prepare(), before = f.journal.read(prepared.plan.id)
      clearNative(f); f.fence.mockResolvedValue(true)
      await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow(OWNERSHIP)
      expect(native(f)).toEqual(ZERO)
      expect(f.fence).toHaveBeenCalledTimes(1)
      expect(f.journal.read(prepared.plan.id)).toEqual(before)
      expect(before).toMatchObject({ state: 'prepared', events: [expect.anything()] })
    })
    itHardened.each([
      ['reports unresolved', (f: Fixture) => f.fence.mockResolvedValueOnce(false).mockResolvedValueOnce(true)],
      ['throws', (f: Fixture) => f.fence.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('journal unreadable'))],
    ])('fence that %s after the identity read prevents the requesting boundary and any upload', async (_name, arrange) => {
      const f = fixture(), prepared = await f.service.prepare(), before = f.journal.read(prepared.plan.id)
      clearNative(f); arrange(f)
      await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow(OWNERSHIP)
      expect(native(f)).toEqual({ ...ZERO, info: 1 })
      expect(f.fence).toHaveBeenCalledTimes(2)
      const after = f.journal.read(prepared.plan.id)
      expect(after).toEqual(before)
      expect(after.events.map(event => event.state)).not.toContain('requesting')
      expect(f.journal.pending()).toEqual([])
      expect(f.device.firmwareRecoveryReadOnly).toBe(false)
    })
    itHardened('resolved fence (false) permits the authorized custom path and is consulted at each boundary', async () => {
      const f = fixture(), prepared = await f.service.prepare()
      expect(f.fence).toHaveBeenCalledTimes(2)
      expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('awaiting-boot')
      expect(f.fence).toHaveBeenCalledTimes(4)
      expect(native(f)).toMatchObject({ info: 2, preflight: 1, upload: 1 })
      expect(f.device.uploadFirmware).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: ACCEPTED_H1E_FIRMWARE.versionNumber }), expect.objectContaining({ allowDowngrade: false }))
    })
    const releaseless: Array<[string, (f: Fixture) => FirmwareInstallService]> = [
      ['no fence callback and qualification off', f => withoutFence(f, { qualificationEnabled: false })],
      ['throwing fence callback and qualification off', f => { f.fence.mockRejectedValue(new Error('journal unreadable')); return new FirmwareInstallService({ ...f.deps, qualificationEnabled: false }) }],
    ]
    itHardened.each(releaseless)('status and observe stay usable with %s, consult no fence and issue no upload', async (_name, build) => {
      const f = fixture(), prepared = await f.service.prepare()
      await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)
      clearNative(f)
      const service = build(f)
      expect(service.status().map(attempt => attempt.plan.id)).toEqual([prepared.plan.id])
      f.device.getDeviceInfo.mockResolvedValueOnce({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: ACCEPTED_H1E_FIRMWARE.versionNumber, versionCode: '6.3.4' })
      expect((await service.observe(prepared.plan.id, 0)).state).toBe('confirmed')
      expect(f.fence).not.toHaveBeenCalled()
      expect(native(f)).toEqual({ ...ZERO, info: 1, verify: 1 })
      await expect(service.prepare()).rejects.toThrow('qualification is not enabled')
    })
  })
  itHardened('bounds repeated timeouts and retains a slot for final confirmation', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)
    for (let index = 3; index < 64; index++) f.journal.append(prepared.plan.id, { state: 'uncertain', at: 1000000, reason: 'bounded-observation' })
    expect(f.journal.append(prepared.plan.id, { state: 'uncertain', at: 1000000, reason: 'overflow' }).events).toHaveLength(63)
    expect(f.journal.append(prepared.plan.id, { state: 'confirmed', at: 1000000, reason: 'readbacks' }).events).toHaveLength(64)
    expect(new FirmwareInstallJournal(f.journal.folder).pending()).toEqual([])
  })
})

describe('VAD install 393992 / 6.3.8_vad001 admission (real pinned image, injected device)', () => {
  it('parses the actual compose-3 container and matches its exact descriptor pin', () => {
    const image = readFileSync(VAD_IMAGE)
    expect(createHash('sha256').update(image).digest('hex')).toBe(VAD_H1E_FIRMWARE.sha256)
    expect(image.length).toBe(VAD_H1E_FIRMWARE.bytes)
    expect(parseFirmwareImage(new Uint8Array(image))).toMatchObject({
      model: VAD_H1E_FIRMWARE.model,
      board: 'ats2835p_evb',
      versionNumber: VAD_H1E_FIRMWARE.versionNumber,
      versionName: VAD_H1E_FIRMWARE.versionName,
      bytes: VAD_H1E_FIRMWARE.bytes,
    })
  })

  it('prepares and executes only from exact 393990 / 6.3.6, then requests custom postboot readbacks', async () => {
    const f = vadFixture(), prepared = await f.service.prepare('vad')
    expect(prepared).toMatchObject({ state: 'prepared', plan: {
      sourceVersion: 393990,
      targetVersion: VAD_H1E_FIRMWARE.versionNumber,
      imageSha256: VAD_H1E_FIRMWARE.sha256,
      imageBytes: VAD_H1E_FIRMWARE.bytes,
    } })
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()

    f.device.uploadFirmware.mockImplementationOnce(async () => {
      expect(new FirmwareInstallJournal(f.journal.folder).read(prepared.plan.id).events.map(event => event.state)).toEqual(['prepared', 'requesting'])
      return { status: 'uploaded', reason: 'transfer-acknowledged', installation: 'unverified' }
    })
    expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('awaiting-boot')
    expect(f.device.uploadFirmware).toHaveBeenCalledOnce()
    expect(f.device.uploadFirmware).toHaveBeenCalledWith(
      expect.objectContaining({ ...VAD_H1E_FIRMWARE, image: expect.any(Uint8Array) }),
      expect.objectContaining({ model: 'hidock-h1e', versionNumber: 393990, versionCode: '6.3.6', allowDowngrade: false }),
    )

    f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393992, versionCode: '6.3.8_vad001' })
    expect((await f.service.observe(prepared.plan.id, 0)).state).toBe('confirmed')
    expect(f.device.verifyFirmwareUpdateBoot).toHaveBeenCalledWith(expect.objectContaining({
      serialNumber: 'PRIVATE-TEST-DOCK',
      sourceVersionNumber: 393990,
      versionNumber: VAD_H1E_FIRMWARE.versionNumber,
      customRecording: true,
    }), 3)
  })

  it.each([
    ['the prior vector source', 393988, '6.3.4'],
    ['a mismatched code for 393990', 393990, '6.3.5'],
    ['a different numeric source', 393991, '6.3.7'],
  ])('refuses preparation from %s before preflight or journal creation', async (_label, versionNumber, versionCode) => {
    const f = vadFixture()
    f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber, versionCode })
    await expect(f.service.prepare('vad')).rejects.toThrow('does not permit')
    expect(f.device.getDeviceInfo).toHaveBeenCalledOnce()
    expect(f.device.getFirmwareUpdatePreflight).not.toHaveBeenCalled()
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
    expect(f.journal.all()).toEqual([])
  })

  it('refuses execute when the exact source code changes after preparation, before requesting or upload', async () => {
    const f = vadFixture(), prepared = await f.service.prepare('vad')
    const before = f.journal.read(prepared.plan.id)
    f.device.getDeviceInfo.mockResolvedValue({ model: 'hidock-h1e', serialNumber: 'PRIVATE-TEST-DOCK', versionNumber: 393990, versionCode: '6.3.5' })
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('changed after preparation')
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
    expect(f.journal.read(prepared.plan.id)).toEqual(before)
    expect(f.journal.read(prepared.plan.id).events.map(event => event.state)).toEqual(['prepared'])
  })
})
