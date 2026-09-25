import { describe, it, expect, vi } from 'vitest'
import { upgradeDatabaseWhenAlone, PROGRESS_REPORT_MS, type BrainUpgradeDeps } from '../brain-upgrade'

const versions = { onDisk: 57, needed: 58 }

function deps(overrides: Partial<BrainUpgradeDeps> = {}) {
  const calls: string[] = []
  const events: Array<Record<string, unknown>> = []
  let launchListener: (() => void) | null = null
  const d: BrainUpgradeDeps = {
    takeLock: vi.fn(() => {
      calls.push('take')
      return true
    }),
    releaseLock: vi.fn(() => calls.push('release')),
    onAppLaunchRefused: vi.fn((listener: () => void) => {
      launchListener = listener
      return () => {
        calls.push('unsubscribe')
        launchListener = null
      }
    }),
    upgrade: vi.fn(async () => {
      calls.push('upgrade')
    }),
    openApp: vi.fn(() => calls.push('open-app')),
    report: vi.fn((e: Record<string, unknown>) => {
      events.push(e)
    }),
    ...overrides,
  }
  return { d, calls, events, launch: () => launchListener?.() }
}

describe('upgradeDatabaseWhenAlone', () => {
  it('upgrades while holding the lock and gives it back afterwards', async () => {
    const { d, calls, events } = deps()
    await upgradeDatabaseWhenAlone(versions, d)
    expect(calls).toEqual(['take', 'upgrade', 'unsubscribe', 'release'])
    expect(events[0]).toEqual({ event: 'upgrading', fromVersion: 57, toVersion: 58 })
    expect(events.at(-1)).toEqual({ event: 'upgraded', toVersion: 58 })
    expect(d.openApp).not.toHaveBeenCalled()
  })

  it('never touches the file when another HiDock holds the lock', async () => {
    const { d } = deps({ takeLock: vi.fn(() => false) })
    await expect(upgradeDatabaseWhenAlone(versions, d)).rejects.toThrow(
      /schema v57 and this code needs v58, and another HiDock holds it/
    )
    expect(d.upgrade).not.toHaveBeenCalled()
    // The lock was never ours, so there is nothing to give back.
    expect(d.releaseLock).not.toHaveBeenCalled()
  })

  it('gives the lock back when the upgrade fails, and passes the failure on', async () => {
    const { d, calls } = deps({
      upgrade: vi.fn(async () => {
        throw new Error('Required pre-migration backup failed')
      }),
    })
    await expect(upgradeDatabaseWhenAlone(versions, d)).rejects.toThrow(/backup failed/)
    expect(calls).toEqual(['take', 'unsubscribe', 'release'])
  })

  it('opens the app after the upgrade when the owner tried to open it during it', async () => {
    const ctx = deps()
    ctx.d.upgrade = vi.fn(async () => {
      ctx.launch()
      ctx.launch()
      ctx.calls.push('upgrade')
    })
    await upgradeDatabaseWhenAlone(versions, ctx.d)
    // Opened once, and only after the lock is back: the app needs it to start.
    expect(ctx.calls).toEqual(['take', 'upgrade', 'unsubscribe', 'release', 'open-app'])
    expect(ctx.events.filter((e) => e.event === 'app-launch-waiting')).toHaveLength(1)
  })

  it('opens the app the owner asked for even when the upgrade failed', async () => {
    const ctx = deps()
    ctx.d.upgrade = vi.fn(async () => {
      ctx.launch()
      throw new Error('migration failed')
    })
    await expect(upgradeDatabaseWhenAlone(versions, ctx.d)).rejects.toThrow(/migration failed/)
    expect(ctx.calls).toEqual(['take', 'unsubscribe', 'release', 'open-app'])
  })

  it('throttles backup byte counts but always reports phase changes', async () => {
    let t = 0
    const ctx = deps({ now: () => t })
    ctx.d.upgrade = vi.fn(async (onProgress) => {
      onProgress({ phase: 'backup', copiedBytes: 1, totalBytes: 100 })
      t += 100
      onProgress({ phase: 'backup', copiedBytes: 2, totalBytes: 100 }) // dropped: too soon
      t += PROGRESS_REPORT_MS
      onProgress({ phase: 'backup', copiedBytes: 50, totalBytes: 100 })
      t += 1
      onProgress({ phase: 'backup', copiedBytes: 100, totalBytes: 100 }) // the finish always goes out
      onProgress({ phase: 'migrating', fromVersion: 57, toVersion: 58 })
    })
    await upgradeDatabaseWhenAlone(versions, ctx.d)
    const progress = ctx.events.filter((e) => e.event === 'upgrade-progress')
    expect(progress.map((e) => (e.phase === 'backup' ? e.copiedBytes : e.phase))).toEqual([1, 50, 100, 'migrating'])
  })
})
