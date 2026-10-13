/** Ephemeral containment: the launch starts no automatic work and never rewrites the owner's saved settings. */
export function isRecoveryMode(): boolean {
  return process.argv.includes('--recovery-mode') || process.env.HIDOCK_RECOVERY_MODE === '1'
}

/** Explicit operator qualification: recovery containment stays on, and the
 * firmware install may be prepared and executed. The flag alone enables nothing. */
export function isFirmwareQualificationLaunch(): boolean {
  return isRecoveryMode() && process.argv.includes('--firmware-qualification')
}
