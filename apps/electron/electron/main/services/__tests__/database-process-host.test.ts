// @vitest-environment node
/**
 * The host and the server wired together through an in-memory process, so
 * restarts, queueing, giving up and close can be driven step by step.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { BackupWorkerProcess } from '../sqlite-backup-executor'
import { createDatabaseProcessHost, DatabaseProcessExitedError } from '../database-process/host'
import { createDatabaseServer } from '../database-process/server'
import { createInProcessDatabaseClient } from '../database-process/client'
import { deserializeError, serializeError, type MainToProcess, type ProcessToMain } from '../database-process/protocol'

interface FakeProcess extends BackupWorkerProcess { crash(code?: number): void; fromProcess(message: ProcessToMain): void; closes: number }

function fakeProcess(operations: Record<string, (...args: any[]) => unknown>, options: { failOpen?: boolean } = {}): FakeProcess {
  const events = new EventEmitter()
  let alive = true
  const proc = {
    pid: 4242,
    closes: 0,
    on(event: string, listener: (...args: any[]) => void) { events.on(event, listener); return proc },
    once(event: string, listener: (...args: any[]) => void) { events.once(event, listener); return proc },
    postMessage(message: unknown) {
      if (!alive) throw new Error('gone')
      queueMicrotask(() => server.handle(structuredClone(message) as MainToProcess))
    },
    kill() { proc.crash(1) },
    fromProcess(message: ProcessToMain) { queueMicrotask(() => events.emit('message', structuredClone(message))) },
    crash(code = 1) {
      if (!alive) return
      alive = false
      queueMicrotask(() => events.emit('exit', code))
    },
  } as FakeProcess
  const server = createDatabaseServer({
    send: (message: ProcessToMain) => { if (alive) queueMicrotask(() => events.emit('message', structuredClone(message))) },
    operations: () => operations,
    open: async () => {
      if (options.failOpen) throw new Error('cannot open the library')
      return 75
    },
    applyConfig: () => undefined,
    close: () => { proc.closes++ },
    exit: (code) => proc.crash(code),
    closeGraceMs: 20,
  })
  return proc
}

const init = { config: {}, appVersion: 't', boot: 'full' as const }

describe('database process host', () => {
  it('answers, rebuilds named errors and refuses before start', async () => {
    const host = createDatabaseProcessHost({
      fork: () => fakeProcess({ add: (a: number, b: number) => a + b, boom: () => { throw Object.assign(new RangeError('too far'), { code: 'E_FAR' }) } }),
      backup: async () => undefined,
      errorClasses: { RangeError },
    })
    await expect(host.call('add', [1, 2])).rejects.toThrow(/not started/)
    expect(await host.start(init)).toBe(75)
    expect(await host.call('add', [2, 3])).toBe(5)
    const error = await host.call('boom', []).catch((e) => e)
    expect(error).toBeInstanceOf(RangeError)
    expect(error.message).toBe('too far')
    expect(error.code).toBe('E_FAR')
    await host.close()
  })

  it('rejects in-flight requests on a crash, queues new ones and sends them after the restart', async () => {
    const forks: FakeProcess[] = []
    let release: (() => void) | null = null
    const ops = {
      slow: () => new Promise<string>((resolve) => { release = () => resolve('late') }),
      pid: () => forks.length,
    }
    const host = createDatabaseProcessHost({
      fork: () => { const p = fakeProcess(ops); forks.push(p); return p },
      backup: async () => undefined,
      restartDelaysMs: [10],
    })
    await host.start(init)
    const inFlight = host.call('slow', [])
    await new Promise((r) => setTimeout(r, 5))
    forks[0].crash()
    await expect(inFlight).rejects.toBeInstanceOf(DatabaseProcessExitedError)
    expect(host.state()).toBe('restarting')
    const queued = host.call('pid', [])
    expect(await queued).toBe(2)
    expect(release).not.toBeNull()
    await host.close()
  })

  it('gives up after too many exits and says why', async () => {
    const forks: FakeProcess[] = []
    const host = createDatabaseProcessHost({
      fork: () => { const p = fakeProcess({ ping: () => 1 }); forks.push(p); return p },
      backup: async () => undefined,
      restartDelaysMs: [1],
      maxRestarts: 2,
    })
    await host.start(init)
    for (let i = 0; i < 3; i++) {
      forks[forks.length - 1].crash()
      await new Promise((r) => setTimeout(r, 15))
    }
    expect(host.state()).toBe('failed')
    await expect(host.call('ping', [])).rejects.toThrow(/exited 3 times/)
  })

  it('fails start when the library cannot be opened', async () => {
    const host = createDatabaseProcessHost({ fork: () => fakeProcess({}, { failOpen: true }), backup: async () => undefined })
    await expect(host.start(init)).rejects.toThrow('cannot open the library')
    expect(host.state()).toBe('failed')
  })

  it('closes the connection once and lets a running operation finish its unit first', async () => {
    const forks: FakeProcess[] = []
    let finished = false
    const host = createDatabaseProcessHost({
      fork: () => { const p = fakeProcess({ pass: async () => { await new Promise((r) => setTimeout(r, 5)); finished = true; return 'done' } }); forks.push(p); return p },
      backup: async () => undefined,
    })
    await host.start(init)
    const pass = host.call('pass', [])
    await host.close()
    expect(finished).toBe(true)
    expect(forks[0].closes).toBe(1)
    expect(await pass.catch((e) => e)).toBe('done')
    await expect(host.call('pass', [])).rejects.toBeInstanceOf(DatabaseProcessExitedError)
  })

  it('relays a backup the process asks for, with progress', async () => {
    let ran = 0
    const proc = fakeProcess({})
    const sent: MainToProcess[] = []
    const post = proc.postMessage.bind(proc)
    proc.postMessage = (message: unknown) => { sent.push(message as MainToProcess); post(message) }
    const host = createDatabaseProcessHost({
      fork: () => proc,
      backup: async (_request, options) => { ran++; options?.onProgress?.({ copiedBytes: 5, totalBytes: 10 }) },
    })
    await host.start(init)
    proc.fromProcess({ type: 'backup-request', id: 1, request: { sourcePath: 'a', partialPath: 'b', targetPath: 'c', pagesPerStep: 1, checkFreeSpace: false } })
    await new Promise((r) => setTimeout(r, 10))
    expect(ran).toBe(1)
    expect(sent.filter((m) => m.type === 'backup-progress')).toEqual([{ type: 'backup-progress', id: 1, progress: { copiedBytes: 5, totalBytes: 10 } }])
    expect(sent.filter((m) => m.type === 'backup-result')).toEqual([{ type: 'backup-result', id: 1, ok: true }])
    await host.close()
  })
})

describe('error serialization', () => {
  it('keeps name, message, stack and cloneable fields; stringifies the rest', () => {
    const error = Object.assign(new TypeError('bad'), { code: 7, weird: { fn: () => 1 } })
    const back = deserializeError(serializeError(error))
    expect(back.name).toBe('TypeError')
    expect(back.message).toBe('bad')
    expect((back as unknown as { code: number }).code).toBe(7)
    expect(typeof (back as unknown as { weird: unknown }).weird).toBe('string')
    expect(back.stack).toBe(error.stack)
  })
})

describe('in-process database client', () => {
  it('runs the operation at the moment of the call and refuses names that are not operations', async () => {
    const calls: string[] = []
    const client = createInProcessDatabaseClient(() => ({ ping: () => { calls.push('ping'); return { pid: 1 } } }) as never)
    const pending = client.call('ping')
    expect(calls).toEqual(['ping'])
    expect(await pending).toEqual({ pid: 1 })
    await expect((client.call as (op: string) => Promise<unknown>)('__proto__')).rejects.toThrow(/No database operation named __proto__/)
    await expect((client.call as (op: string) => Promise<unknown>)('constructor')).rejects.toThrow(/No database operation/)
  })
})
