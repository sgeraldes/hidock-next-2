import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ACCEPTED_H1E_FIRMWARE, ACCEPTED_H1E_FORWARD_STOCK_RESTORE, parseFirmwareImage, permitsFirmwareVersion, isFirmwareUpdateCardReady } from '@hidock/jensen-protocol'
import type { JensenDevice } from '@hidock/jensen-protocol'
import { FirmwareInstallJournal, type InstallAttempt } from './firmware-install-journal'

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
/** Previously admitted development diagnostic image. Its fixed path is supplied only by the
 * development main process, and preparation is limited to the exact 393988/6.3.4 base. */
export const DIAGNOSTIC_H1E_FIRMWARE = Object.freeze({
  model: 'hidock-h1e' as const,
  versionNumber: 393990 as const,
  versionName: '6.3.6_vectors001',
  bytes: 3429376,
  sha256: 'd0cd083ff19d56325dca12ea7785c4deb270cf2ef68fa6b7af1c64b0baa651a0',
})
/** Fixed combined slots/VAD image. The development main process supplies its only artifact path. */
export const VAD_H1E_FIRMWARE = Object.freeze({
  model: 'hidock-h1e' as const,
  versionNumber: 393992 as const,
  versionName: '6.3.8_vad001',
  bytes: 3429376,
  sha256: 'b6bf41d0359748c26242a902cf2949de6a18b216a2853a35f3a5d189b8b3f9ba',
})
export type FirmwareInstallTarget = 'hardened' | 'stock-forward' | 'diagnostic' | 'vad'
export interface FirmwareInstallDependencies {
  device(): JensenDevice
  journal: FirmwareInstallJournal
  artifactPath: string
  forwardStockArtifactPath?: string
  /** Fixed development-only path. Absent (packaged launches) means the diagnostic target is unavailable. */
  diagnosticArtifactPath?: string
  /** Fixed development-only path. Absent (packaged launches) means the VAD target is unavailable. */
  vadArtifactPath?: string
  idle(): boolean
  maintenanceReadOnly?: boolean
  /** Must be explicitly true for prepare/execute. Absent means false (fail closed). */
  qualificationEnabled?: boolean
  /** Must be explicitly true, in addition to qualification, for the stock-forward target. */
  stockRecoveryEnabled?: boolean
  /** Filesystem-only check of both durable restore journals. Missing or failed
   * checks fence writes; status/boot observation remain available. */
  hasUnresolvedStorageOwnership?: () => Promise<boolean>
  serialize<T>(fn: () => Promise<T>): Promise<T>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}
/** Sole-owner installation. Preparing and observing are read-only. Executing a
 * prepared token is the only entry which sends CMD8/9; never retried automatically. */
export class FirmwareInstallService {
  private now: () => number
  private sleep: (ms: number) => Promise<void>
  constructor(private deps: FirmwareInstallDependencies) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }
  private descriptor(version: number) {
    if (version === ACCEPTED_H1E_FIRMWARE.versionNumber) return ACCEPTED_H1E_FIRMWARE
    if (version === ACCEPTED_H1E_FORWARD_STOCK_RESTORE.versionNumber) return ACCEPTED_H1E_FORWARD_STOCK_RESTORE
    if (version === DIAGNOSTIC_H1E_FIRMWARE.versionNumber) return DIAGNOSTIC_H1E_FIRMWARE
    if (version === VAD_H1E_FIRMWARE.versionNumber) return VAD_H1E_FIRMWARE
    throw new Error('Unknown firmware target')
  }
  private image(version: number): Uint8Array {
    const descriptor = this.descriptor(version), forward = version === ACCEPTED_H1E_FORWARD_STOCK_RESTORE.versionNumber
    const diagnostic = version === DIAGNOSTIC_H1E_FIRMWARE.versionNumber
    const vad = version === VAD_H1E_FIRMWARE.versionNumber
    const path = vad ? this.deps.vadArtifactPath : diagnostic ? this.deps.diagnosticArtifactPath : forward ? this.deps.forwardStockArtifactPath : this.deps.artifactPath
    if (!path) throw new Error('Selected firmware resource unavailable')
    const image = new Uint8Array(readFileSync(path)), metadata = parseFirmwareImage(image)
    const versionName = vad ? VAD_H1E_FIRMWARE.versionName : diagnostic ? DIAGNOSTIC_H1E_FIRMWARE.versionName : forward ? '6.3.5_reaRestore2' : '6.3.4_restore001'
    if (image.length !== descriptor.bytes || hash(image) !== descriptor.sha256 ||
      metadata?.versionNumber !== descriptor.versionNumber || metadata.versionName !== versionName) throw new Error('Selected firmware image failed its exact pin or container checks')
    return image
  }
  private requireQualification(): void {
    if (this.deps.qualificationEnabled !== true) throw new Error('Firmware qualification is not enabled for this launch')
  }
  private requireStockRecovery(): void {
    if (this.deps.stockRecoveryEnabled !== true) throw new Error('Stock-forward firmware recovery is not enabled for this launch')
  }
  private async requireResolvedStorageOwnership(): Promise<void> {
    try {
      if (this.deps.hasUnresolvedStorageOwnership && await this.deps.hasUnresolvedStorageOwnership() === false) return
    } catch { /* Unreadable ownership cannot authorize a firmware transition. */ }
    throw new Error('Storage write ownership is unresolved or unavailable')
  }
  status(): InstallAttempt[] { return this.deps.journal.all() }
  prepare(target: FirmwareInstallTarget = 'hardened'): Promise<InstallAttempt> {
    return this.deps.serialize(async () => {
      this.requireQualification()
      if (target !== 'hardened' && target !== 'stock-forward' && target !== 'diagnostic' && target !== 'vad') throw new Error('Unknown firmware target')
      if (target === 'stock-forward') this.requireStockRecovery()
      await this.requireResolvedStorageOwnership()
      if (this.deps.journal.pending().length || !this.deps.idle()) throw new Error('Device owner is busy or an update is unresolved')
      const descriptor = target === 'stock-forward' ? ACCEPTED_H1E_FORWARD_STOCK_RESTORE : target === 'diagnostic' ? DIAGNOSTIC_H1E_FIRMWARE : target === 'vad' ? VAD_H1E_FIRMWARE : ACCEPTED_H1E_FIRMWARE
      const image = this.image(descriptor.versionNumber), device = this.deps.device(), info = await device.getDeviceInfo(5)
      const knownReturn = target === 'hardened' && info?.versionNumber === 393989 && info.versionCode === '6.3.5'
      const targetSourceMatches = target === 'vad'
        ? info?.versionNumber === 393990 && info.versionCode === '6.3.6'
        : target !== 'hardened'
          ? info?.versionNumber === 393988 && info.versionCode === '6.3.4'
          : true
      if (!info || info.model !== 'hidock-h1e' || !permitsFirmwareVersion(descriptor.versionNumber, info.versionNumber, knownReturn) ||
        !targetSourceMatches) throw new Error('Fresh H1E identity/version does not permit this image')
      const ready = await device.getFirmwareUpdatePreflight(5)
      if (!ready || ready.serialNumber !== info.serialNumber || ready.versionNumber !== info.versionNumber || ready.activeRecording || !isFirmwareUpdateCardReady(ready.card) || ready.card.freeMiB < Math.max(6, Math.ceil(image.length / 1048576)) || !this.deps.idle()) throw new Error('Strict native readiness or owner idle check failed')
      await this.requireResolvedStorageOwnership()
      const at = this.now()
      return this.deps.journal.create({ id: randomUUID(), preparedAt: at, expiresAt: at + 300000,
        serialHash: hash(info.serialNumber), sourceVersion: info.versionNumber,
        targetVersion: descriptor.versionNumber, imageSha256: hash(image), imageBytes: image.length })
    })
  }
  execute(id: string, expectedSha256: string): Promise<InstallAttempt> {
    return this.deps.serialize(async () => {
      this.requireQualification()
      await this.requireResolvedStorageOwnership()
      const attempt = this.deps.journal.read(id), plan = attempt.plan, device = this.deps.device()
      const descriptor = this.descriptor(plan.targetVersion)
      if (descriptor.versionNumber === ACCEPTED_H1E_FORWARD_STOCK_RESTORE.versionNumber) this.requireStockRecovery()
      if (device.firmwareRecoveryReadOnly || device.deviceValidationReadOnly || this.deps.maintenanceReadOnly || attempt.state !== 'prepared' || this.deps.journal.pending().length || plan.expiresAt <= this.now() || plan.preparedAt > this.now() || expectedSha256 !== plan.imageSha256 || expectedSha256 !== descriptor.sha256 || !this.deps.idle()) throw new Error('Prepared attempt expired, changed, unresolved, read-only or busy')
      const image = this.image(descriptor.versionNumber), info = await device.getDeviceInfo(5)
      if (!info || hash(info.serialNumber) !== plan.serialHash || info.versionNumber !== plan.sourceVersion || info.model !== 'hidock-h1e' || plan.imageBytes !== image.length ||
        ((descriptor.versionNumber === 393989 || descriptor.versionNumber === DIAGNOSTIC_H1E_FIRMWARE.versionNumber) && (info.versionNumber !== 393988 || info.versionCode !== '6.3.4')) ||
        (descriptor.versionNumber === VAD_H1E_FIRMWARE.versionNumber && (info.versionNumber !== 393990 || info.versionCode !== '6.3.6'))) throw new Error('Device or image changed after preparation')
      // The durable record must succeed BEFORE the native update request can run.
      await this.requireResolvedStorageOwnership()
      this.deps.journal.append(id, { state: 'requesting', at: this.now(), reason: 'explicit-prepared-execution' })
      try {
        const knownReturn = descriptor.versionNumber === 393988 && info.versionNumber === 393989 && info.versionCode === '6.3.5'
        const result = await device.uploadFirmware({ ...descriptor, image }, { ...info, allowDowngrade: knownReturn })
        const state = result.status === 'uploaded' ? 'awaiting-boot' : result.status === 'rejected' ? 'rejected' : 'uncertain'
        const current = this.deps.journal.append(id, { state, at: this.now(), reason: result.reason.slice(0, 240) })
        device.firmwareRecoveryReadOnly = state !== 'rejected'
        return current
      } catch {
        device.firmwareRecoveryReadOnly = true
        return this.deps.journal.append(id, { state: 'uncertain', at: this.now(), reason: 'host-exception-after-durable-request-boundary' })
      }
    })
  }
  /** Explicit observation resumes after a crash. No CMD8/9, CPU reset or power
   * cycle is issued. Exact version equality avoids false downgrade confirmation. */
  observe(id: string, deadlineMs = 180000): Promise<InstallAttempt> {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > 180000) return Promise.reject(new Error('Invalid boot observation deadline'))
    return this.deps.serialize(async () => {
      const attempt = this.deps.journal.read(id), device = this.deps.device()
      if (!['requesting', 'awaiting-boot', 'uncertain'].includes(attempt.state)) throw new Error('No unresolved attempt to observe')
      device.firmwareRecoveryReadOnly = true
      const end = this.now() + deadlineMs
      do {
        try {
          if (!device.isConnected()) await device.tryConnect()
          const info = await device.getDeviceInfo(3)
          if (info && hash(info.serialNumber) === attempt.plan.serialHash && info.versionNumber === attempt.plan.targetVersion) {
            const result = await device.verifyFirmwareUpdateBoot({ serialNumber: info.serialNumber, versionNumber: attempt.plan.targetVersion, sourceVersionNumber: attempt.plan.sourceVersion, customRecording: attempt.plan.targetVersion === ACCEPTED_H1E_FIRMWARE.versionNumber || attempt.plan.targetVersion === DIAGNOSTIC_H1E_FIRMWARE.versionNumber || attempt.plan.targetVersion === VAD_H1E_FIRMWARE.versionNumber }, 3)
            if (result.status === 'confirmed') {
              // Clear process and durable fences only after strict native readbacks.
              const current = this.deps.journal.append(id, { state: 'confirmed', at: this.now(), reason: 'exact-identity-version-capabilities-idle-card;image-not-attested' })
              device.firmwareRecoveryReadOnly = this.deps.maintenanceReadOnly ?? false
              return current
            }
          }
        } catch { /* A reconnect/read failure is uncertainty, never a retry. */ }
        if (this.now() >= end) break
        await this.sleep(Math.min(3000, end - this.now()))
      } while (this.now() <= end)
      const current = this.deps.journal.read(id)
      return this.deps.journal.append(id, { state: 'uncertain', at: this.now(), reason: current.state === 'requesting' ? 'host-restarted-before-transfer-outcome' : 'automatic-reboot-or-postboot-readbacks-unconfirmed' })
    })
  }
}
