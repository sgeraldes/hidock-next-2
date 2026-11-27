/**
 * Runs the real database process entry as a Node child process for tests.
 *
 * The entry is bundled with esbuild the way electron-vite bundles it (source
 * of @hidock/database, packages external) into out/test-database-process, so
 * the child resolves better-sqlite3 from this app's node_modules (one N-API
 * binary for Node and Electron since better-sqlite3 13). Node's 'advanced'
 * IPC serialization is structured clone, as Electron's MessagePortMain is.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BackupWorkerProcess } from '../sqlite-backup-executor'

const appRoot = resolve(__dirname, '../../../..')
const outDir = resolve(appRoot, 'out/test-database-process')
let bundled: Promise<string> | null = null

/** Bundle electron/main/database-process.ts once per test file; returns the script path. */
export function bundleDatabaseProcess(): Promise<string> {
  if (!bundled) {
    bundled = (async () => {
      const { build } = await import('esbuild')
      mkdirSync(outDir, { recursive: true })
      const outfile = resolve(outDir, `database-process-${process.pid}.cjs`)
      await build({
        entryPoints: [resolve(appRoot, 'electron/main/database-process.ts')],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        tsconfig: resolve(appRoot, 'tsconfig.node.json'),
        packages: 'external',
        alias: {
          '@hidock/database': resolve(appRoot, '../../packages/database/src/index.ts'),
          '@hidock/transcription': resolve(appRoot, '../../packages/transcription/src/index.ts'),
        },
        logLevel: 'error',
      })
      return outfile
    })()
  }
  return bundled
}

/** The child as the host sees a utility process. */
export function adaptChildProcess(child: ChildProcess): BackupWorkerProcess {
  const adapter: BackupWorkerProcess = {
    get pid() { return child.pid },
    on(event, listener) { child.on(event, listener); return adapter },
    once(event, listener) { child.once(event, listener); return adapter },
    removeListener(event, listener) { child.removeListener(event, listener); return adapter },
    postMessage(message) {
      if (!child.connected) throw new Error('The database child process is not connected')
      child.send(message as never)
    },
    kill() { child.kill('SIGKILL') },
  }
  return adapter
}

export function forkDatabaseProcess(script: string, children: ChildProcess[]): BackupWorkerProcess {
  const child = fork(script, [], {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    cwd: appRoot,
  })
  children.push(child)
  return adaptChildProcess(child)
}
