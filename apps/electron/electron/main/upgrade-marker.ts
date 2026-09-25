/**
 * The file that says "a headless brain is upgrading the database right now".
 *
 * It lives in the shared instance-lock folder (see single-instance.ts), which
 * every HiDock of this user can find whatever its profile. Two readers need it:
 *
 * - an app launch the lock refused, so it can tell the owner the app opens by
 *   itself after the update instead of vanishing without a word;
 * - a second headless brain the lock refused, so it waits for the first one's
 *   upgrade instead of failing an agent's call with the wrong reason.
 *
 * A marker whose process is gone, or that is older than any upgrade could be,
 * is ignored: a brain killed mid-upgrade cannot leave the next launch waiting.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface UpgradeMarker {
  pid: number
  startedAt: string
}

/** Older than this is not an upgrade in progress, whatever the file says. */
export const UPGRADE_MARKER_MAX_AGE_MS = 35 * 60 * 1000

export function upgradeMarkerPath(lockDir: string): string {
  return join(lockDir, 'brain-upgrading.json')
}

export function writeUpgradeMarker(lockDir: string, pid: number, now = new Date()): void {
  const marker: UpgradeMarker = { pid, startedAt: now.toISOString() }
  writeFileSync(upgradeMarkerPath(lockDir), JSON.stringify(marker))
}

/** Remove the marker, but only this process's own. */
export function clearUpgradeMarker(lockDir: string, pid: number): void {
  const path = upgradeMarkerPath(lockDir)
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpgradeMarker>
    if (marker.pid === pid) rmSync(path, { force: true })
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone we cannot signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The marker of an upgrade that is really running now, or null. */
export function readLiveUpgradeMarker(
  lockDir: string,
  now = Date.now(),
  isAlive: (pid: number) => boolean = processIsAlive
): UpgradeMarker | null {
  const path = upgradeMarkerPath(lockDir)
  if (!existsSync(path)) return null
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpgradeMarker>
    if (typeof marker.pid !== 'number' || typeof marker.startedAt !== 'string') return null
    const age = now - Date.parse(marker.startedAt)
    if (!(age >= 0 && age < UPGRADE_MARKER_MAX_AGE_MS)) return null
    if (!isAlive(marker.pid)) return null
    return { pid: marker.pid, startedAt: marker.startedAt }
  } catch {
    return null
  }
}
