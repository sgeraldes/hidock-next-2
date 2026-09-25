/**
 * The headless brain upgrading the database file when nobody else has it open.
 *
 * Installing a build that adds a migration left the file one schema behind the
 * code, and the read-only brain refused to open it until the owner opened the
 * app window by hand (24-sep-2026: every agent call failed with "schema v57 and
 * this code needs v58"). An agent's morning pull cannot wait for that.
 *
 * So the brain runs the upgrade itself, under one condition: it holds the lock
 * every HiDock of this user competes for (see single-instance.ts). Holding it
 * proves no app is running or starting against the file, and while it is held
 * an app launch cannot start either: it asks this process to come forward and
 * quits. The upgrade is the app's own boot path, so it takes the same
 * fail-closed backup before any migration runs. The lock goes back the moment
 * the upgrade ends, and if the owner tried to open the app meanwhile, the app
 * is opened then.
 *
 * When the lock is taken, the app is open or starting, and it upgrades the
 * file itself. The brain leaves, as before.
 */

import type { BootProgress } from '@hidock/database'

export interface BrainUpgradeDeps {
  /** Take the shared HiDock lock; `false` when another HiDock holds it. */
  takeLock: () => boolean
  /** Give the lock back. */
  releaseLock: () => void
  /** Call `listener` when an app launch finds the lock taken. Returns the unsubscribe. */
  onAppLaunchRefused: (listener: () => void) => () => void
  /** The app's own boot of the database (backup, migrations), then close it. */
  upgrade: (onProgress: (p: BootProgress) => void) => Promise<void>
  /** Start the app the owner tried to open during the upgrade. */
  openApp: () => void
  /** One line of JSON for the launcher's log. */
  report: (event: Record<string, unknown>) => void
  /** Clock, for throttling progress lines. */
  now?: () => number
}

/** At most one progress line per this many milliseconds; the launcher reads them as a heartbeat. */
export const PROGRESS_REPORT_MS = 5000

export async function upgradeDatabaseWhenAlone(
  versions: { onDisk: number; needed: number },
  deps: BrainUpgradeDeps
): Promise<void> {
  const now = deps.now ?? Date.now
  if (!deps.takeLock()) {
    throw new Error(
      `The database is on schema v${versions.onDisk} and this code needs v${versions.needed}, ` +
        'and another HiDock holds it (the app is open or starting). The app upgrades the file ' +
        'when it starts; the headless brain leaves it alone.'
    )
  }

  let appLaunchRefused = false
  const unsubscribe = deps.onAppLaunchRefused(() => {
    if (!appLaunchRefused) deps.report({ event: 'app-launch-waiting', reason: 'the database is being upgraded' })
    appLaunchRefused = true
  })

  deps.report({ event: 'upgrading', fromVersion: versions.onDisk, toVersion: versions.needed })
  let lastProgress = Number.NEGATIVE_INFINITY
  try {
    await deps.upgrade((p) => {
      const t = now()
      // Phase changes always go out; byte counts are throttled.
      const isByteCount = p.phase === 'backup' && p.copiedBytes < p.totalBytes
      if (isByteCount && t - lastProgress < PROGRESS_REPORT_MS) return
      lastProgress = t
      deps.report({ event: 'upgrade-progress', ...p })
    })
    deps.report({ event: 'upgraded', toVersion: versions.needed })
  } finally {
    unsubscribe()
    deps.releaseLock()
    // Open it even when the upgrade failed: the app retries it with its own
    // splash, and the owner who clicked gets the window they asked for.
    if (appLaunchRefused) {
      deps.report({ event: 'opening-app' })
      deps.openApp()
    }
  }
}
