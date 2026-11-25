// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSqliteBackupExecutor, type BackupWorkerProcess } from '../sqlite-backup-executor'
import { adaptUtilityProcess, type UtilityProcessChild } from '../sqlite-backup-host-adapter'

let tempRoot = ''
afterEach(() => {
  if (!tempRoot) return
  const safeRoot = resolve(tmpdir()) + '\\'
  const target = resolve(tempRoot) + '\\'
  if (!target.toLowerCase().startsWith(safeRoot.toLowerCase())) throw new Error('refusing cleanup outside the test temp root')
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 4242
  readonly sent: unknown[] = []
  constructor(private readonly partialPath: string, private readonly terminal: 'done' | 'fatal-error') { super() }

  postMessage(message: unknown): void {
    this.sent.push(message)
    const item = message as { type?: string }
    if (item.type === 'run') {
      writeFileSync(this.partialPath, 'worker partial')
      queueMicrotask(() => {
        if (this.terminal === 'done') this.emit('message', { type: 'done' })
        else this.emit('error', 'FatalError', 'sqlite-backup-worker.js:12', 'isolated fatal-error report')
      })
    } else if (item.type === 'shutdown') {
      queueMicrotask(() => this.emit('exit', 0))
    }
  }

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 1))
    return true
  }
}

function makeExecutor(child: FakeUtilityProcess, timeoutMs = 500) {
  return createSqliteBackupExecutor({
    workerPath: () => 'sqlite-backup-worker.js',
    fork: () => adaptUtilityProcess(child as unknown as UtilityProcessChild) as BackupWorkerProcess,
    timeoutMs,
  })
}

function request(name: string) {
  return {
    sourcePath: 'source.sqlite',
    partialPath: join(tempRoot, name + '.partial'),
    targetPath: join(tempRoot, name),
    pagesPerStep: 256,
    checkFreeSpace: false,
  }
}

describe('Electron UtilityProcess host adapter', () => {
  it('forwards the direct terminal message payload so a completed backup resolves', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hidock-utility-adapter-'))
    const job = request('direct-message.sqlite')
    const child = new FakeUtilityProcess(job.partialPath, 'done')
    const manager = makeExecutor(child)
    try {
      await expect(manager.execute(job)).resolves.toBeUndefined()
      expect(child.sent).toContainEqual({ type: 'shutdown' })
      expect(existsSync(job.partialPath)).toBe(true)
    } finally {
      await manager.close()
    }
  })

  it('converts Electron FatalError arguments to an Error and cleans the owned partial', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hidock-utility-adapter-'))
    const job = request('fatal-error.sqlite')
    const child = new FakeUtilityProcess(job.partialPath, 'fatal-error')
    const manager = makeExecutor(child)
    try {
      await expect(manager.execute(job)).rejects.toThrow(
        /Utility process FatalError at sqlite-backup-worker\.js:12: isolated fatal-error report/
      )
      expect(existsSync(job.partialPath)).toBe(false)
    } finally {
      await manager.close()
    }
  })
})

