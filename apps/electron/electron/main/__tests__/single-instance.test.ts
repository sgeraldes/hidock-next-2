import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app } from 'electron'
import { acquireSingleInstanceLock } from '../single-instance'

// The lock folder is created before the lock is taken; nothing is written in tests.
const mkdirSpy = vi.hoisted(() => vi.fn())
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, mkdirSync: mkdirSpy, default: { ...actual, mkdirSync: mkdirSpy } }
})

// Mock electron. `app` is an event emitter + lock API; we capture registered
// handlers so we can invoke the `second-instance` callback directly.
vi.mock('electron', () => {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    app: {
      requestSingleInstanceLock: vi.fn(),
      quit: vi.fn(),
      // userData starts as the profile; setPath records every change.
      __paths: { userData: 'C:/profiles/benchmark', appData: 'C:/Users/me/AppData/Roaming' } as Record<string, string>,
      getPath: vi.fn(function (this: unknown, name: string) {
        return (app as unknown as { __paths: Record<string, string> }).__paths[name]
      }),
      setPath: vi.fn((name: string, value: string) => {
        ;(app as unknown as { __paths: Record<string, string> }).__paths[name] = value
      }),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        ;(handlers[event] ??= []).push(cb)
      }),
      // test helper (not part of the real electron surface)
      __emit: (event: string, ...args: unknown[]) => {
        for (const cb of handlers[event] ?? []) cb(...args)
      },
      __handlers: handlers
    }
  }
})

const mockedApp = app as unknown as {
  requestSingleInstanceLock: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  __emit: (event: string, ...args: unknown[]) => void
  __handlers: Record<string, Array<(...args: unknown[]) => void>>
}

function makeWindow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides
  }
}

describe('acquireSingleInstanceLock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset captured handlers between tests.
    for (const key of Object.keys(mockedApp.__handlers)) {
      delete mockedApp.__handlers[key]
    }
  })

  it('returns true and does NOT quit when the lock is acquired (primary)', () => {
    mockedApp.requestSingleInstanceLock.mockReturnValue(true)

    const result = acquireSingleInstanceLock({ getMainWindow: () => null })

    expect(result).toBe(true)
    expect(mockedApp.quit).not.toHaveBeenCalled()
    // The primary registers a second-instance handler.
    expect(mockedApp.on).toHaveBeenCalledWith('second-instance', expect.any(Function))
  })

  it('returns false and quits immediately when the lock is NOT acquired (secondary)', () => {
    mockedApp.requestSingleInstanceLock.mockReturnValue(false)

    const result = acquireSingleInstanceLock({ getMainWindow: () => null })

    expect(result).toBe(false)
    expect(mockedApp.quit).toHaveBeenCalledTimes(1)
    // A secondary must NOT register a second-instance handler.
    expect(mockedApp.on).not.toHaveBeenCalled()
  })

  it('focuses the existing main window on second-instance', () => {
    mockedApp.requestSingleInstanceLock.mockReturnValue(true)
    const win = makeWindow()

    acquireSingleInstanceLock({ getMainWindow: () => win as never })
    mockedApp.__emit('second-instance')

    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.restore).not.toHaveBeenCalled()
  })

  it('restores a minimized main window before focusing it', () => {
    mockedApp.requestSingleInstanceLock.mockReturnValue(true)
    const win = makeWindow({ isMinimized: vi.fn(() => true) })

    acquireSingleInstanceLock({ getMainWindow: () => win as never })
    mockedApp.__emit('second-instance')

    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('ignores a destroyed main window and falls back to the splash', () => {
    mockedApp.requestSingleInstanceLock.mockReturnValue(true)
    const destroyedMain = makeWindow({ isDestroyed: vi.fn(() => true) })
    const splash = makeWindow()

    acquireSingleInstanceLock({
      getMainWindow: () => destroyedMain as never,
      getSplashWindow: () => splash as never
    })
    mockedApp.__emit('second-instance')

    // Destroyed main window is not touched...
    expect(destroyedMain.show).not.toHaveBeenCalled()
    // ...and the splash gets focus instead.
    expect(splash.show).toHaveBeenCalledTimes(1)
    expect(splash.focus).toHaveBeenCalledTimes(1)
  })

  it('surfaces the splash window when the main window is not yet created', () => {
    mockedApp.requestSingleInstanceLock.mockReturnValue(true)
    const splash = makeWindow()

    acquireSingleInstanceLock({
      getMainWindow: () => null,
      getSplashWindow: () => splash as never
    })
    mockedApp.__emit('second-instance')

    expect(splash.show).toHaveBeenCalledTimes(1)
    expect(splash.focus).toHaveBeenCalledTimes(1)
  })

  it('does not throw on second-instance when neither window exists', () => {
    mockedApp.requestSingleInstanceLock.mockReturnValue(true)

    acquireSingleInstanceLock({ getMainWindow: () => null })

    expect(() => mockedApp.__emit('second-instance')).not.toThrow()
  })

  it('takes one lock for every profile, and puts the profile back', () => {
    const paths = (app as unknown as { __paths: Record<string, string> }).__paths
    paths.userData = 'C:/profiles/benchmark'
    let userDataWhenRequested = ''
    mockedApp.requestSingleInstanceLock.mockImplementation(() => {
      userDataWhenRequested = paths.userData
      return true
    })

    acquireSingleInstanceLock({ getMainWindow: () => null })

    expect(userDataWhenRequested.split('\\').join('/')).toBe('C:/Users/me/AppData/Roaming/HiDock Next/instance-lock')
    expect(paths.userData).toBe('C:/profiles/benchmark')
    expect(mkdirSpy.mock.calls[0][0]).toBe(userDataWhenRequested)
  })

  it('puts the profile back even when the lock request throws', () => {
    const paths = (app as unknown as { __paths: Record<string, string> }).__paths
    paths.userData = 'C:/profiles/dev'
    mockedApp.requestSingleInstanceLock.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => acquireSingleInstanceLock({ getMainWindow: () => null })).toThrow('boom')
    expect(paths.userData).toBe('C:/profiles/dev')
  })
})
