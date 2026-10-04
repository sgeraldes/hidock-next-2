import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { parseProbeLine, parseComputeApps, queryGpuProcesses, startProbe, PROBE_SCRIPT } from '../src/probe.mjs'

describe('probe output', () => {
  it('reads one snapshot per line', () => {
    const snapshot = parseProbeLine(
      '{"notificationState":3,"processes":[{"name":"game.exe","path":"D:\\\\g\\\\game.exe"},{"name":"System","path":""}]}'
    )
    expect(snapshot.notificationState).toBe(3)
    expect(snapshot.processes).toEqual([
      { name: 'game.exe', path: 'D:\\g\\game.exe' },
      { name: 'System', path: '' },
    ])
  })

  it('reads a look where the programs did not change', () => {
    expect(parseProbeLine('{"notificationState":2,"unchanged":true}')).toEqual({
      notificationState: 2,
      processes: null,
    })
  })

  it('ignores a line that is not a snapshot instead of pausing on it', () => {
    expect(parseProbeLine('')).toBeNull()
    expect(parseProbeLine('WARNING: something')).toBeNull()
    expect(parseProbeLine('{"processes":"nope"}')).toBeNull()
  })

  it('reads the CUDA programs nvidia-smi lists', () => {
    expect(parseComputeApps('1234, C:\\Tools\\python.exe\r\n88, [Insufficient Permissions]\n\n')).toEqual([
      { pid: 1234, name: 'C:\\Tools\\python.exe' },
      { pid: 88, name: '[Insufficient Permissions]' },
    ])
    expect(parseComputeApps('No running processes found')).toEqual([])
  })

  it('treats a failing nvidia-smi as no GPU programs', async () => {
    const run = async () => {
      throw new Error('nvidia-smi not found')
    }
    expect(await queryGpuProcesses(run)).toEqual([])
  })
})

describe('the probe process', () => {
  function fakeSpawn() {
    const children = []
    const spawnFn = (cmd, args) => {
      const child = new EventEmitter()
      child.args = args
      child.stdout = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr = new EventEmitter()
      child.stderr.setEncoding = () => {}
      child.kill = () => {
        child.killed = true
        child.emit('exit', null)
      }
      children.push(child)
      return child
    }
    return { spawnFn, children }
  }

  it('hands each snapshot over, even when a line arrives in pieces', () => {
    const { spawnFn, children } = fakeSpawn()
    const seen = []
    const probe = startProbe({ onSnapshot: (s) => seen.push(s), spawnFn, restartDelayMs: 10 })
    children[0].stdout.emit('data', '{"notificationState":5,"proc')
    children[0].stdout.emit('data', 'esses":[]}\n{"notificationState":3,"processes":[]}\n')
    expect(seen.map((s) => s.notificationState)).toEqual([5, 3])
    probe.stop()
  })

  it('fills a look without a program list with the last list it had', () => {
    const { spawnFn, children } = fakeSpawn()
    const seen = []
    const probe = startProbe({ onSnapshot: (s) => seen.push(s), spawnFn })
    children[0].stdout.emit('data', '{"notificationState":5,"processes":[{"name":"a.exe","path":"C:\\\\a.exe"}]}\n')
    children[0].stdout.emit('data', '{"notificationState":3,"unchanged":true}\n')
    expect(seen[1]).toEqual({ notificationState: 3, processes: [{ name: 'a.exe', path: 'C:\\a.exe' }] })
    probe.stop()
  })

  it('tells the script whose child it is, so it exits with the host', () => {
    const { spawnFn, children } = fakeSpawn()
    const probe = startProbe({ onSnapshot: () => {}, spawnFn })
    expect(children[0].args).toContain('-ParentPid')
    expect(children[0].args).toContain(String(process.pid))
    probe.stop()
  })

  it('starts again after the script dies, and not after stop', async () => {
    const { spawnFn, children } = fakeSpawn()
    const probe = startProbe({ onSnapshot: () => {}, spawnFn, restartDelayMs: 5 })
    children[0].emit('exit', 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(children.length).toBe(2)
    probe.stop()
    expect(children[1].killed).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(children.length).toBe(2)
  })
})

describe.runIf(process.platform === 'win32')('the host and its probe', () => {
  it('looks only while it is working or paused for a game', async () => {
    const { start } = await import('../src/main.mjs')
    const { mkdtempSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const root = mkdtempSync(join(tmpdir(), 'hidock-probe-host-'))
    const host = await start({ root, overrides: { port: 0 } })
    try {
      expect(host.watching()).toBe(false)
      await host.state.apply('start')
      expect(host.watching()).toBe(true)
      await host.state.apply('pause')
      expect(host.watching()).toBe(false)
      await host.state.apply('toggle')
      await host.state.gamePause('cs2.exe is running')
      expect(host.watching()).toBe(true)
      await host.state.apply('stop')
      expect(host.watching()).toBe(false)
    } finally {
      await new Promise((r) => host.server.close(r))
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe.runIf(process.platform === 'win32')('the real probe script', () => {
  it('reports the screen state and the running programs with their paths', async () => {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE_SCRIPT, '-Once'],
      { windowsHide: true, timeout: 60_000 }
    )
    const snapshot = parseProbeLine(stdout.trim().split('\n').pop())
    expect(snapshot).not.toBeNull()
    expect(Number.isInteger(snapshot.notificationState)).toBe(true)
    const node = snapshot.processes.find((p) => p.path && p.path.toLowerCase() === process.execPath.toLowerCase())
    expect(node?.name.toLowerCase()).toBe(join(process.execPath).split('\\').pop().toLowerCase())
  }, 60_000)
})
