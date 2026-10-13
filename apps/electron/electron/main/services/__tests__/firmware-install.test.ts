// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ACCEPTED_H1E_FIRMWARE } from '@hidock/jensen-protocol'
import { FirmwareInstallJournal } from '../firmware-install-journal'
import { FirmwareInstallService } from '../firmware-install'

const IMAGE = resolve(__dirname, '../../../../resources/firmware/h1e-rea-hardened.bin')
const SERIAL = 'TEST-DOCK-SERIAL'
const info = (versionNumber: number, versionCode: string, serialNumber = SERIAL) =>
  ({ model: 'hidock-h1e', serialNumber, versionNumber, versionCode })
const preflight = (versionNumber: number) =>
  ({ model: 'hidock-h1e', serialNumber: SERIAL, versionNumber, activeRecording: false, card: { freeMiB: 2000, capacityMiB: 32000, statusCode: 0x900 } })

const folders: string[] = []
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })))

function fixture(source = 393984) {
  const folder = mkdtempSync(join(tmpdir(), 'hidock-firmware-test-')); folders.push(folder)
  const journal = new FirmwareInstallJournal(join(folder, 'journal'))
  const device: any = {
    firmwareRecoveryReadOnly: false,
    deviceValidationReadOnly: false,
    getDeviceInfo: vi.fn(async () => info(source, '6.3.0')),
    getFirmwareUpdatePreflight: vi.fn(async () => preflight(source)),
    isConnected: () => true, tryConnect: vi.fn(),
    uploadFirmware: vi.fn(async () => ({ status: 'uploaded', reason: 'transfer-acknowledged', installation: 'unverified' })),
    verifyFirmwareUpdateBoot: vi.fn(async () => ({ status: 'confirmed', reason: 'readbacks', imageAttested: false })),
  }
  let time = 1000000, busy = false
  const fence = vi.fn(async (): Promise<boolean> => false)
  const deps = { device: () => device, journal, artifactPath: IMAGE, idle: () => !busy, qualificationEnabled: true,
    hasUnresolvedStorageOwnership: fence,
    serialize: async <T>(fn: () => Promise<T>) => fn(), now: () => time, sleep: async (ms: number) => { time += ms } }
  return { folder, journal, device, deps, fence, service: new FirmwareInstallService(deps),
    advance: (ms: number) => { time += ms }, busy: () => { busy = true } }
}

describe('pinned image', () => {
  it('is the exact 6.3.4_restore001 image the app is built to flash', () => {
    const bytes = readFileSync(IMAGE)
    expect(bytes.length).toBe(3429376)
    expect(ACCEPTED_H1E_FIRMWARE.bytes).toBe(3429376)
    expect(ACCEPTED_H1E_FIRMWARE.versionNumber).toBe(393988)
    expect(ACCEPTED_H1E_FIRMWARE.sha256).toBe('4942c98f9a150f09b9a31b606e7e9d985e99b16873c5ef64e6e17667808d82e8') // pragma: allowlist secret (public image digest)
  })
})

describe('prepare', () => {
  it('reads the real image, journals a plan and never uploads or stores the serial', async () => {
    const f = fixture(), attempt = await f.service.prepare()
    expect(attempt.state).toBe('prepared')
    expect(attempt.plan).toMatchObject({ imageSha256: ACCEPTED_H1E_FIRMWARE.sha256, imageBytes: ACCEPTED_H1E_FIRMWARE.bytes, sourceVersion: 393984, targetVersion: 393988 })
    expect(readFileSync(join(f.journal.folder, attempt.plan.id, 'plan.json'), 'utf8')).not.toContain(SERIAL)
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
    expect(new FirmwareInstallJournal(f.journal.folder).read(attempt.plan.id)).toEqual(attempt)
  })
  it('refuses without the qualification launch, before any device I/O', async () => {
    const f = fixture()
    for (const qualificationEnabled of [undefined, false]) {
      const service = new FirmwareInstallService({ ...f.deps, qualificationEnabled })
      await expect(service.prepare()).rejects.toThrow('not enabled')
    }
    expect(f.device.getDeviceInfo).not.toHaveBeenCalled()
    expect(f.fence).not.toHaveBeenCalled()
  })
  it('refuses the same version and any older version, and never selects another target', async () => {
    const equal = fixture(393988)
    await expect(equal.service.prepare()).rejects.toThrow('does not permit')
    const newer = fixture(393989)
    newer.device.getDeviceInfo.mockResolvedValue(info(393989, '6.3.5'))
    await expect(newer.service.prepare()).rejects.toThrow('does not permit')
    const stock = fixture()
    await expect(stock.service.prepare('stock-forward')).rejects.toThrow('stock firmware recovery is not available')
    for (const f of [equal, newer, stock]) {
      expect(f.device.uploadFirmware).not.toHaveBeenCalled()
      expect(f.journal.all()).toEqual([])
    }
  })
  it('refuses a busy owner, a recording device, a full card, an unready card and a storage owner', async () => {
    const busy = fixture(); busy.busy()
    await expect(busy.service.prepare()).rejects.toThrow('busy')
    const recording = fixture(); recording.device.getFirmwareUpdatePreflight.mockResolvedValue({ ...preflight(393984), activeRecording: true })
    await expect(recording.service.prepare()).rejects.toThrow('readiness')
    const full = fixture(); full.device.getFirmwareUpdatePreflight.mockResolvedValue({ ...preflight(393984), card: { freeMiB: 2, capacityMiB: 32000, statusCode: 0x900 } })
    await expect(full.service.prepare()).rejects.toThrow('readiness')
    const unready = fixture(); unready.device.getFirmwareUpdatePreflight.mockResolvedValue({ ...preflight(393984), card: { freeMiB: 2000, capacityMiB: 32000, statusCode: 0 } })
    await expect(unready.service.prepare()).rejects.toThrow('readiness')
    const owned = fixture(); owned.fence.mockResolvedValue(true)
    await expect(owned.service.prepare()).rejects.toThrow('Storage write ownership')
    const missing = fixture()
    await expect(new FirmwareInstallService({ ...missing.deps, hasUnresolvedStorageOwnership: undefined }).prepare()).rejects.toThrow('Storage write ownership')
    for (const f of [busy, recording, full, unready, owned, missing]) expect(f.device.uploadFirmware).not.toHaveBeenCalled()
  })
  it('refuses an image that is not the pinned one', async () => {
    const f = fixture(), bad = join(f.folder, 'bad.bin'); writeFileSync(bad, new Uint8Array(512))
    await expect(new FirmwareInstallService({ ...f.deps, artifactPath: bad }).prepare()).rejects.toThrow('pin')
  })
})

describe('execute', () => {
  it('writes the requesting record before the upload and uploads exactly once, with no downgrade', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    f.device.uploadFirmware.mockImplementationOnce(async () => {
      expect(new FirmwareInstallJournal(f.journal.folder).pending()[0].state).toBe('requesting')
      return { status: 'uploaded', reason: 'transfer-acknowledged', installation: 'unverified' }
    })
    expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('awaiting-boot')
    expect(f.device.uploadFirmware).toHaveBeenCalledTimes(1)
    expect(f.device.uploadFirmware).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 393988, sha256: ACCEPTED_H1E_FIRMWARE.sha256 }), expect.objectContaining({ allowDowngrade: false }))
    expect(f.device.firmwareRecoveryReadOnly).toBe(true)
  })
  it('after a host exception keeps the attempt uncertain, blocks a new one and never retries', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    f.device.uploadFirmware.mockRejectedValueOnce(new Error('host stopped after the request'))
    expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('uncertain')
    const restarted = new FirmwareInstallService({ ...f.deps, journal: new FirmwareInstallJournal(f.journal.folder) })
    await expect(restarted.prepare()).rejects.toThrow('unresolved')
    await expect(restarted.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('unresolved')
    expect(f.device.uploadFirmware).toHaveBeenCalledTimes(1)
    expect(f.device.firmwareRecoveryReadOnly).toBe(true)
  })
  it('refuses a wrong digest, an expired token, a changed device, a read-only owner and a busy owner', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await expect(f.service.execute(prepared.plan.id, '0'.repeat(64))).rejects.toThrow()
    f.device.getDeviceInfo.mockResolvedValueOnce(info(393984, '6.3.0', 'OTHER-DOCK'))
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('changed')
    f.device.firmwareRecoveryReadOnly = true
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('read-only')
    f.device.firmwareRecoveryReadOnly = false
    f.device.deviceValidationReadOnly = true
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('read-only')
    f.device.deviceValidationReadOnly = false
    f.busy()
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('busy')
    f.advance(300001)
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('expired')
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
    expect(f.journal.read(prepared.plan.id).state).toBe('prepared')
  })
  it('refuses without the qualification launch and when a storage owner appears after preparation', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await expect(new FirmwareInstallService({ ...f.deps, qualificationEnabled: false }).execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('not enabled')
    f.fence.mockResolvedValue(true)
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow('Storage write ownership')
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
    expect(f.journal.read(prepared.plan.id)).toMatchObject({ state: 'prepared', events: [expect.anything()] })
  })
  it('closes a native rejection without a lingering fence', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    f.device.uploadFirmware.mockResolvedValueOnce({ status: 'rejected', reason: 'busy' })
    expect((await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).state).toBe('rejected')
    expect(f.journal.pending()).toEqual([])
    expect(f.device.firmwareRecoveryReadOnly).toBe(false)
  })
})

describe('observe', () => {
  it('confirms only on the exact target version and native readbacks, and sends no write', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)
    f.device.getDeviceInfo.mockResolvedValueOnce(info(393989, '6.3.5'))
    expect((await f.service.observe(prepared.plan.id, 0)).state).toBe('uncertain')
    expect(f.device.verifyFirmwareUpdateBoot).not.toHaveBeenCalled()
    f.device.getDeviceInfo.mockResolvedValueOnce(info(393988, '6.3.4'))
    expect((await f.service.observe(prepared.plan.id, 0)).state).toBe('confirmed')
    expect(f.device.verifyFirmwareUpdateBoot).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 393988, sourceVersionNumber: 393984, customRecording: true }), 3)
    expect(f.device.uploadFirmware).toHaveBeenCalledTimes(1)
    expect(f.device.firmwareRecoveryReadOnly).toBe(false)
  })
  it('works without the qualification launch so an interrupted attempt can always be resumed', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)
    f.device.getDeviceInfo.mockResolvedValue(info(393988, '6.3.4'))
    const observer = new FirmwareInstallService({ ...f.deps, qualificationEnabled: false })
    expect((await observer.observe(prepared.plan.id, 0)).state).toBe('confirmed')
  })
  it('keeps the owner read-only while the outcome is uncertain', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)
    f.device.getDeviceInfo.mockResolvedValue(null)
    expect((await f.service.observe(prepared.plan.id, 0)).state).toBe('uncertain')
    expect(f.device.firmwareRecoveryReadOnly).toBe(true)
  })
  it('rejects a deadline above three minutes', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await expect(f.service.observe(prepared.plan.id, 180001)).rejects.toThrow('deadline')
  })
})

describe('journal', () => {
  it('fails closed on a torn record instead of inferring success', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    writeFileSync(join(f.journal.folder, prepared.plan.id, 'event-0001.json'), '{"state":"requesting"')
    expect(() => new FirmwareInstallJournal(f.journal.folder).pending()).toThrow()
    await expect(f.service.execute(prepared.plan.id, prepared.plan.imageSha256)).rejects.toThrow()
    expect(f.device.uploadFirmware).not.toHaveBeenCalled()
  })
  it('bounds repeated timeouts and keeps a slot for the final confirmation', async () => {
    const f = fixture(), prepared = await f.service.prepare()
    await f.service.execute(prepared.plan.id, prepared.plan.imageSha256)
    f.device.getDeviceInfo.mockResolvedValue(null)
    for (let i = 0; i < 80; i++) await f.service.observe(prepared.plan.id, 0)
    expect(f.journal.read(prepared.plan.id).events.length).toBeLessThanOrEqual(64)
    f.device.getDeviceInfo.mockResolvedValue(info(393988, '6.3.4'))
    expect((await f.service.observe(prepared.plan.id, 0)).state).toBe('confirmed')
  })
})
