// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireMachineInstanceLock, machineInstancePipePath, releaseMachineInstanceLock } from '../machine-instance'

const pipe = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\hidock-next-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : join(tmpdir(), `hidock-next-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)

afterEach(async () => {
  await releaseMachineInstanceLock()
})

describe('one HiDock per user, whatever the profile', () => {
  it('lets the first instance run', async () => {
    expect(await acquireMachineInstanceLock({ onSecondLaunch: vi.fn(), pipePath: pipe() })).toBe(true)
  })

  it('stops a second instance and brings the first forward', async () => {
    const path = pipe()
    const shown = vi.fn()
    expect(await acquireMachineInstanceLock({ onSecondLaunch: shown, pipePath: path })).toBe(true)
    expect(await acquireMachineInstanceLock({ onSecondLaunch: vi.fn(), pipePath: path })).toBe(false)
    await vi.waitFor(() => expect(shown).toHaveBeenCalledOnce())
  })

  it('lets a new instance run once the first has quit', async () => {
    const path = pipe()
    expect(await acquireMachineInstanceLock({ onSecondLaunch: vi.fn(), pipePath: path })).toBe(true)
    await releaseMachineInstanceLock()
    expect(await acquireMachineInstanceLock({ onSecondLaunch: vi.fn(), pipePath: path })).toBe(true)
  })

  it('names the lock after the OS user, not the profile', () => {
    const path = machineInstancePipePath()
    expect(path).toMatch(/hidock-next-/)
    expect(path).not.toMatch(/HIDOCK_DEV_USERDATA|artifacts/i)
  })
})
