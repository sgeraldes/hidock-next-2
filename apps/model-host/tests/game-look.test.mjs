import { describe, it, expect } from 'vitest'
import { createGameLook } from '../src/main.mjs'
import { HostState } from '../src/state.mjs'
import { GameWatcher, normalizeGameMode } from '../src/game-mode.mjs'

const QUIET = { notificationState: 5, processes: [] }
const GAME = { notificationState: 5, processes: [{ name: 'cs2.exe', path: 'D:\\steamapps\\common\\cs2\\cs2.exe' }] }

async function setup({ start = true, gpu = { name: 'RTX 4090' } } = {}) {
  const state = new HostState()
  if (start) await state.apply('start')
  const settings = normalizeGameMode({ resumeAfterMinutes: 0 })
  const watcher = new GameWatcher({ settings: () => settings })
  const logs = []
  let gpuCalls = 0
  const look = createGameLook({
    state,
    watcher,
    settings: () => settings,
    gpu,
    log: (m) => logs.push(m),
    queryGpu: async () => {
      gpuCalls++
      return []
    },
  })
  return { state, look, logs, gpuCalls: () => gpuCalls }
}

describe('one look of game mode', () => {
  it('says in the host window when it pauses and when it resumes', async () => {
    const { look, logs } = await setup()
    await look(GAME)
    await look(QUIET)
    expect(logs).toEqual(['[game mode] paused: cs2.exe is running', '[game mode] resumed'])
  })

  it('does not ask nvidia-smi while the host is stopped', async () => {
    const { look, gpuCalls } = await setup({ start: false })
    await look(GAME)
    expect(gpuCalls()).toBe(0)
  })

  it('does not ask nvidia-smi on a machine without an NVIDIA driver', async () => {
    const { look, gpuCalls } = await setup({ gpu: null })
    await look(QUIET)
    expect(gpuCalls()).toBe(0)
  })

  it('tells the watcher which GPU program is the host’s own worker', async () => {
    const state = new HostState()
    await state.apply('start')
    state.workerPid = 4242
    const settings = normalizeGameMode({})
    const look = createGameLook({
      state,
      watcher: new GameWatcher({ settings: () => settings }),
      settings: () => settings,
      gpu: { name: 'x' },
      log: () => {},
      queryGpu: async () => [{ pid: 4242, name: 'C:\\Python311\\python.exe' }],
    })
    await look(QUIET)
    expect(state.state).toBe('ready')
  })

  it('never runs two looks at once', async () => {
    const state = new HostState()
    await state.apply('start')
    const settings = normalizeGameMode({})
    let release
    let calls = 0
    const look = createGameLook({
      state,
      watcher: new GameWatcher({ settings: () => settings }),
      settings: () => settings,
      gpu: { name: 'x' },
      log: () => {},
      queryGpu: () => {
        calls++
        return new Promise((r) => (release = () => r([])))
      },
    })
    const first = look(QUIET)
    await look(QUIET)
    release()
    await first
    expect(calls).toBe(1)
  })
})
