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
  /** Say, for other HiDock processes, that this one is upgrading; and stop saying it. */
  markUpgrading: () => void
  clearUpgrading: () => void
  /** The pid of another headless brain upgrading right now, or null. */
  otherUpgrade: () => number | null
  /** Clock, for throttling progress lines and bounding the wait. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** At most one progress line per this many milliseconds; the launcher reads them as a heartbeat. */
export const PROGRESS_REPORT_MS = 5000

/**
 * How long a refused brain looks for the upgrade marker before deciding the
 * lock belongs to the app: the winner writes it right after taking the lock.
 */
export const MARKER_GRACE_MS = 2000
/** How often a waiting brain looks again. */
export const WAIT_POLL_MS = 1000
/** The longest a brain waits for another one's upgrade; the bridge waits 30 minutes. */
export const WAIT_FOR_OTHER_MS = 30 * 60 * 1000

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Another headless brain holds the lock and is upgrading: wait for it to
 * finish, reporting it the way an own upgrade is reported, so the launcher
 * keeps waiting too. Returns false when no other brain is upgrading.
 */
async function waitForOtherUpgrade(deps: BrainUpgradeDeps): Promise<boolean> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const graceEnds = now() + MARKER_GRACE_MS
  let other = deps.otherUpgrade()
  while (other === null && now() < graceEnds) {
    await sleep(WAIT_POLL_MS / 4)
    other = deps.otherUpgrade()
  }
  if (other === null) return false
  deps.report({ event: 'upgrading', waitingFor: 'another headless brain', pid: other })
  const gives = now() + WAIT_FOR_OTHER_MS
  while (deps.otherUpgrade() !== null) {
    if (now() >= gives) {
      throw new Error(`Another headless brain (pid ${other}) has been upgrading the database for 30 minutes; gave up waiting.`)
    }
    await sleep(WAIT_POLL_MS)
  }
  deps.report({ event: 'upgrade-finished-elsewhere', pid: other })
  return true
}

export async function upgradeDatabaseWhenAlone(
  versions: { onDisk: number; needed: number },
  deps: BrainUpgradeDeps
): Promise<void> {
  const now = deps.now ?? Date.now
  if (!deps.takeLock()) {
    // Two agent calls right after an install start two brains; the second
    // finds the first one's lock. Wait for its upgrade, then read as usual.
    if (await waitForOtherUpgrade(deps)) return
    throw new Error(
      `The database is on schema v${versions.onDisk} and this code needs v${versions.needed}, ` +
        'and another HiDock holds it (the app is open or starting). The app upgrades the file ' +
        'when it starts; the headless brain leaves it alone.'
    )
  }

  // Best effort: without the marker a refused launch just quits silently, as
  // before. It must never cost the lock its release.
  try {
    deps.markUpgrading()
  } catch (error) {
    deps.report({ event: 'upgrade-marker-failed', error: error instanceof Error ? error.message : String(error) })
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
    try {
      deps.clearUpgrading()
    } catch {
      // A marker left behind is ignored once this process is gone.
    }
    deps.releaseLock()
    // Open it even when the upgrade failed: the app retries it with its own
    // splash, and the owner who clicked gets the window they asked for.
    if (appLaunchRefused) {
      deps.report({ event: 'opening-app' })
      deps.openApp()
    }
  }
}
