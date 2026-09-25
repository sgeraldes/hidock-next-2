import { describe, it, expect, vi } from 'vitest'
import {
  upgradeDatabaseWhenAlone,
  PROGRESS_REPORT_MS,
  WAIT_FOR_OTHER_MS,
  type BrainUpgradeDeps,
} from '../brain-upgrade'

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
    markUpgrading: vi.fn(() => calls.push('mark')),
    clearUpgrading: vi.fn(() => calls.push('clear')),
    otherUpgrade: vi.fn(() => null),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  }
  return { d, calls, events, launch: () => launchListener?.() }
}

describe('upgradeDatabaseWhenAlone', () => {
  it('upgrades while holding the lock and gives it back afterwards', async () => {
    const { d, calls, events } = deps()
    await upgradeDatabaseWhenAlone(versions, d)
    expect(calls).toEqual(['take', 'mark', 'upgrade', 'unsubscribe', 'clear', 'release'])
    expect(events[0]).toEqual({ event: 'upgrading', fromVersion: 57, toVersion: 58 })
    expect(events.at(-1)).toEqual({ event: 'upgraded', toVersion: 58 })
    expect(d.openApp).not.toHaveBeenCalled()
  })

  it('never touches the file when another HiDock holds the lock', async () => {
    let t = 0
    const { d } = deps({
      takeLock: vi.fn(() => false),
      now: () => t,
      sleep: vi.fn(async (ms: number) => {
        t += ms
      }),
    })
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
    expect(calls).toEqual(['take', 'mark', 'unsubscribe', 'clear', 'release'])
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
    expect(ctx.calls).toEqual(['take', 'mark', 'upgrade', 'unsubscribe', 'clear', 'release', 'open-app'])
    expect(ctx.events.filter((e) => e.event === 'app-launch-waiting')).toHaveLength(1)
  })

  it('opens the app the owner asked for even when the upgrade failed', async () => {
    const ctx = deps()
    ctx.d.upgrade = vi.fn(async () => {
      ctx.launch()
      throw new Error('migration failed')
    })
    await expect(upgradeDatabaseWhenAlone(versions, ctx.d)).rejects.toThrow(/migration failed/)
    expect(ctx.calls).toEqual(['take', 'mark', 'unsubscribe', 'clear', 'release', 'open-app'])
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

  it('still releases the lock when the marker cannot be written', async () => {
    const { d, calls, events } = deps({
      markUpgrading: vi.fn(() => {
        throw new Error('EACCES')
      }),
    })
    await upgradeDatabaseWhenAlone(versions, d)
    expect(calls).toContain('release')
    expect(events.some((e) => e.event === 'upgrade-marker-failed')).toBe(true)
  })

  it('waits for another brain that is upgrading, instead of failing', async () => {
    // Two agent calls right after an install: the second brain finds the lock
    // taken by the first, whose marker says it is upgrading.
    let checks = 0
    const { d, events } = deps({
      takeLock: vi.fn(() => false),
      otherUpgrade: vi.fn(() => (++checks <= 3 ? 4242 : null)),
    })
    await expect(upgradeDatabaseWhenAlone(versions, d)).resolves.toBeUndefined()
    expect(d.upgrade).not.toHaveBeenCalled()
    expect(d.releaseLock).not.toHaveBeenCalled()
    // Reported as "upgrading" so the bridge keeps waiting.
    expect(events[0]).toMatchObject({ event: 'upgrading', waitingFor: 'another headless brain', pid: 4242 })
    expect(events.at(-1)).toMatchObject({ event: 'upgrade-finished-elsewhere', pid: 4242 })
  })

  it('gives the winner a moment to write its marker before blaming the app', async () => {
    let t = 0
    let checks = 0
    const { d } = deps({
      takeLock: vi.fn(() => false),
      now: () => t,
      sleep: vi.fn(async (ms: number) => {
        t += ms
      }),
      // Absent on the first look, present on the second, gone on the third.
      otherUpgrade: vi.fn(() => {
        checks += 1
        return checks === 2 ? 7 : null
      }),
    })
    await expect(upgradeDatabaseWhenAlone(versions, d)).resolves.toBeUndefined()
  })

  it('stops waiting for another brain after the bound', async () => {
    let t = 0
    const { d } = deps({
      takeLock: vi.fn(() => false),
      now: () => t,
      sleep: vi.fn(async (ms: number) => {
        t += ms
      }),
      otherUpgrade: vi.fn(() => 99),
    })
    await expect(upgradeDatabaseWhenAlone(versions, d)).rejects.toThrow(/gave up waiting/)
    expect(t).toBeGreaterThanOrEqual(WAIT_FOR_OTHER_MS)
  })
})
