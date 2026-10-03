import { describe, it, expect } from 'vitest'
import { HostState, READY, PAUSED, STOPPED } from '../src/state.mjs'
import {
  GAME_MODE_DEFAULTS,
  normalizeGameMode,
  decideGamePause,
  GameWatcher,
} from '../src/game-mode.mjs'

const STEAM_GAME = {
  name: 'eldenring.exe',
  path: 'D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe',
}
const QUIET = { notificationState: 5, processes: [{ name: 'explorer.exe', path: 'C:\\Windows\\explorer.exe' }], gpuProcesses: [] }
const withGame = { ...QUIET, processes: [...QUIET.processes, STEAM_GAME] }

async function readyState(onLeaveReady) {
  const state = new HostState(onLeaveReady ? { onLeaveReady } : {})
  await state.apply('start')
  return state
}

describe('pause and resume from one control', () => {
  it('toggle pauses a working host, and the person is the one who paused it', async () => {
    const state = await readyState()
    await state.apply('toggle')
    expect(state.state).toBe(PAUSED)
    expect(state.pauseInfo().by).toBe('you')
  })

  it('toggle resumes a paused host and starts a stopped one', async () => {
    const state = await readyState()
    await state.apply('pause')
    await state.apply('toggle')
    expect(state.state).toBe(READY)
    await state.apply('stop')
    await state.apply('toggle')
    expect(state.state).toBe(READY)
  })

  it('a pause from the person cancels the running job', async () => {
    const asked = []
    const state = await readyState(async () => asked.push('stop the job'))
    await state.apply('toggle')
    expect(asked).toEqual(['stop the job'])
  })
})

describe('pauses caused by a game', () => {
  it('pause a working host, cancel its job and say which game', async () => {
    const asked = []
    const state = await readyState(async () => asked.push('stop the job'))
    await state.gamePause('eldenring.exe is running')
    expect(state.state).toBe(PAUSED)
    expect(state.pauseInfo()).toMatchObject({ by: 'game', detail: 'eldenring.exe is running' })
    expect(state.reason).toMatch(/game/i)
    expect(asked).toEqual(['stop the job'])
  })

  it('never start a stopped host or take over a pause the person made', async () => {
    const stopped = new HostState()
    await stopped.gamePause('x')
    expect(stopped.state).toBe(STOPPED)

    const paused = await readyState()
    await paused.apply('pause')
    await paused.gamePause('x')
    expect(paused.pauseInfo().by).toBe('you')
    paused.gameResume()
    expect(paused.state).toBe(PAUSED)
  })

  it('resume only what a game paused', async () => {
    const state = await readyState()
    await state.gamePause('x')
    state.gameResume()
    expect(state.state).toBe(READY)
    expect(state.pauseInfo()).toBeNull()
  })

  it('a person who resumes during a game keeps the host working until that game ends', async () => {
    const state = await readyState()
    await state.gamePause('x')
    await state.apply('toggle')
    expect(state.state).toBe(READY)
    expect(state.gameOverride).toBe(true)
    await state.gamePause('x')
    expect(state.state).toBe(READY)
  })
})

describe('what counts as a game', () => {
  const settings = normalizeGameMode({})

  it('a program installed in a game library', () => {
    expect(decideGamePause(withGame, settings)).toMatch(/eldenring\.exe/)
    expect(
      decideGamePause(
        { ...QUIET, processes: [{ name: 'Game.exe', path: 'C:/XboxGames/Forza/Content/Game.exe' }] },
        settings
      )
    ).toMatch(/Game\.exe/)
  })

  it('a program on the always-pause list, with or without .exe, in any case', () => {
    const custom = normalizeGameMode({ alwaysPause: ['Blender'] })
    expect(decideGamePause({ ...QUIET, processes: [{ name: 'blender.exe', path: '' }] }, custom)).toMatch(/blender/i)
  })

  it('an exclusive or borderless full-screen app', () => {
    expect(decideGamePause({ ...QUIET, notificationState: 3 }, settings)).toMatch(/full-screen/i)
    expect(decideGamePause({ ...QUIET, notificationState: 2 }, settings)).toMatch(/full-screen/i)
    // Presentation mode and quiet hours are not games.
    expect(decideGamePause({ ...QUIET, notificationState: 4 }, settings)).toBeNull()
  })

  it('another program computing on the GPU, but never the host itself', () => {
    const other = { ...QUIET, gpuProcesses: [{ pid: 7, name: 'C:\\Tools\\comfy\\python.exe' }] }
    expect(decideGamePause(other, settings)).toMatch(/python\.exe/)
    const ours = {
      ...QUIET,
      gpuProcesses: [{ pid: 8, name: 'C:\\Users\\s\\AppData\\Local\\HiDock Model Host\\runtime\\python\\python.exe' }],
    }
    expect(decideGamePause(ours, settings)).toBeNull()
    const ignored = normalizeGameMode({ ignoreGpu: ['python.exe'] })
    expect(decideGamePause(other, ignored)).toBeNull()
  })

  it('each signal can be turned off', () => {
    const off = normalizeGameMode({ pauseOnGameFolders: false, pauseOnFullscreen: false, pauseOnOtherGpuWork: false })
    expect(decideGamePause({ ...withGame, notificationState: 3, gpuProcesses: [{ pid: 1, name: 'x.exe' }] }, off)).toBeNull()
  })

  it('nothing running is nothing', () => {
    expect(decideGamePause(QUIET, settings)).toBeNull()
  })
})

describe('game mode settings', () => {
  it('fill in what is missing and keep what makes sense', () => {
    const s = normalizeGameMode({ resumeAfterMinutes: '12', alwaysPause: [' a.exe ', '', 'b'] })
    expect(s.enabled).toBe(true)
    expect(s.resumeAfterMinutes).toBe(12)
    expect(s.alwaysPause).toEqual(['a.exe', 'b'])
    expect(s.gameFolders).toEqual(GAME_MODE_DEFAULTS.gameFolders)
  })

  it('refuse a resume delay outside 0 to 120 minutes', () => {
    expect(normalizeGameMode({ resumeAfterMinutes: -3 }).resumeAfterMinutes).toBe(0)
    expect(normalizeGameMode({ resumeAfterMinutes: 999 }).resumeAfterMinutes).toBe(120)
    expect(normalizeGameMode({ resumeAfterMinutes: 'soon' }).resumeAfterMinutes).toBe(GAME_MODE_DEFAULTS.resumeAfterMinutes)
  })
})

describe('the watcher', () => {
  function setup(overrides = {}) {
    let now = 1_000_000
    let settings = normalizeGameMode(overrides)
    const watcher = new GameWatcher({ settings: () => settings, now: () => now })
    return {
      watcher,
      advance: (ms) => (now += ms),
      set: (next) => (settings = normalizeGameMode({ ...overrides, ...next })),
    }
  }

  it('pauses on the first sight of a game', async () => {
    const { watcher } = setup()
    const state = await readyState()
    await watcher.observe(withGame, state)
    expect(state.pauseInfo().by).toBe('game')
  })

  it('resumes only after the game has been gone for the configured time', async () => {
    const { watcher, advance } = setup({ resumeAfterMinutes: 5 })
    const state = await readyState()
    await watcher.observe(withGame, state)
    await watcher.observe(QUIET, state)
    expect(state.state).toBe(PAUSED)
    expect(watcher.resumesAt()).toBe(1_000_000 + 5 * 60_000)
    advance(4 * 60_000)
    await watcher.observe(QUIET, state)
    expect(state.state).toBe(PAUSED)
    advance(60_000)
    await watcher.observe(QUIET, state)
    expect(state.state).toBe(READY)
    expect(watcher.resumesAt()).toBeNull()
  })

  it('a game that comes back during the wait starts the wait again', async () => {
    const { watcher, advance } = setup({ resumeAfterMinutes: 5 })
    const state = await readyState()
    await watcher.observe(withGame, state)
    advance(4 * 60_000)
    await watcher.observe(withGame, state)
    advance(2 * 60_000)
    await watcher.observe(QUIET, state)
    expect(state.state).toBe(PAUSED)
  })

  it('leaves a pause the person made alone when the game ends', async () => {
    const { watcher, advance } = setup({ resumeAfterMinutes: 0 })
    const state = await readyState()
    await state.apply('pause')
    await watcher.observe(withGame, state)
    advance(60_000)
    await watcher.observe(QUIET, state)
    expect(state.pauseInfo().by).toBe('you')
  })

  it('honours a resume during a game, and pauses for the next game', async () => {
    const { watcher } = setup({ resumeAfterMinutes: 0 })
    const state = await readyState()
    await watcher.observe(withGame, state)
    await state.apply('toggle')
    await watcher.observe(withGame, state)
    expect(state.state).toBe(READY)
    await watcher.observe(QUIET, state)
    expect(state.gameOverride).toBe(false)
    await watcher.observe(withGame, state)
    expect(state.state).toBe(PAUSED)
  })

  it('turned off, it never pauses and gives back a pause it made', async () => {
    const { watcher, set } = setup()
    const state = await readyState()
    await watcher.observe(withGame, state)
    set({ enabled: false })
    await watcher.observe(withGame, state)
    expect(state.state).toBe(READY)
  })
})
