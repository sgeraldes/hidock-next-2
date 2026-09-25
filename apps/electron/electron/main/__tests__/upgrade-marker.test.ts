// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearUpgradeMarker,
  readLiveUpgradeMarker,
  upgradeMarkerPath,
  writeUpgradeMarker,
  UPGRADE_MARKER_MAX_AGE_MS,
} from '../upgrade-marker'

const dirs: string[] = []
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hidock-upgrade-marker-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const alive = () => true
const dead = () => false

describe('upgrade marker', () => {
  it('reads back what a live upgrading process wrote', () => {
    const d = dir()
    const now = new Date('2026-09-25T05:00:00Z')
    writeUpgradeMarker(d, 1234, now)
    expect(readLiveUpgradeMarker(d, now.getTime() + 1000, alive)).toEqual({ pid: 1234, startedAt: now.toISOString() })
  })

  it('ignores a marker whose process is gone', () => {
    const d = dir()
    writeUpgradeMarker(d, 1234)
    expect(readLiveUpgradeMarker(d, Date.now(), dead)).toBeNull()
  })

  it('ignores a marker older than any upgrade could be', () => {
    const d = dir()
    const start = new Date('2026-09-25T05:00:00Z')
    writeUpgradeMarker(d, 1234, start)
    expect(readLiveUpgradeMarker(d, start.getTime() + UPGRADE_MARKER_MAX_AGE_MS, alive)).toBeNull()
  })

  it('ignores a missing or unreadable marker', () => {
    const d = dir()
    expect(readLiveUpgradeMarker(d, Date.now(), alive)).toBeNull()
    writeFileSync(upgradeMarkerPath(d), '{not json')
    expect(readLiveUpgradeMarker(d, Date.now(), alive)).toBeNull()
  })

  it('removes only its own marker', () => {
    const d = dir()
    writeUpgradeMarker(d, 1234)
    clearUpgradeMarker(d, 999)
    expect(existsSync(upgradeMarkerPath(d))).toBe(true)
    clearUpgradeMarker(d, 1234)
    expect(existsSync(upgradeMarkerPath(d))).toBe(false)
  })

  it('treats this very process as alive by default', () => {
    const d = dir()
    writeUpgradeMarker(d, process.pid)
    expect(readLiveUpgradeMarker(d)?.pid).toBe(process.pid)
  })
})
