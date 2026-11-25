/** Ephemeral containment: never rewrite the owner's saved settings. */
export function isRecoveryMode(): boolean {
  return process.argv.includes('--recovery-mode') || process.env.HIDOCK_RECOVERY_MODE === '1'
}

/** Explicit temporary maintenance launch: no automatic work, read-only USB.
 * The protocol owner enforces its read allowlist independently of the IPC gate. */
export function isFirmwareReadOnlyLaunch(): boolean {
  return isRecoveryMode() && process.argv.includes('--firmware-read-only')
}

/** Contained device qualification: no automatic application work. The owner
 * independently starts with the protocol's expanded read-only validation gate. */
export function isDeviceValidationLaunch(): boolean {
  return isRecoveryMode() && process.argv.includes('--device-validation')
}

/** Explicit operator qualification retains recovery containment of background
 * jobs while permitting manually requested hardware operations. Never implicit. */
export function isFirmwareQualificationLaunch(): boolean {
  return isRecoveryMode() && process.argv.includes('--firmware-qualification') &&
    !process.argv.includes('--device-validation') && !process.argv.includes('--firmware-read-only')
}

/** Stock-forward firmware is a separate opt-in on top of an authorized
 * qualification launch. The flag alone, without qualification, enables nothing. */
export function isFirmwareStockRecoveryLaunch(): boolean {
  return isFirmwareQualificationLaunch() && process.argv.includes('--firmware-stock-recovery')
}
