/**
 * A dated log file of warnings and errors, main process and window (29-sep-2026).
 *
 * The app kept its logs only in memory, so twice in one day a failure could not
 * be read back afterwards: the 2 h 27 min download stall and a Library crash in
 * the window. This writes every main-process `console.warn` / `console.error`,
 * every window console warning or error, and a crashed or hung window, to
 * `<userData>/logs/hidock-YYYY-MM-DD.log`, one file per day, kept 14 days.
 *
 * Writes are appended in order without blocking the caller. A day's file stops
 * at MAX_BYTES_PER_DAY (one line says so), and each entry is cut at
 * MAX_ENTRY_CHARS, so a log storm cannot fill the disk.
 */
import { appendFile, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { format } from 'util'

export const KEEP_DAYS = 14
export const MAX_BYTES_PER_DAY = 20 * 1024 * 1024
export const MAX_ENTRY_CHARS = 8000
const FILE_RE = /^hidock-(\d{4}-\d{2}-\d{2})\.log$/

export type LogSource = 'main' | 'window'
export type LogLevel = 'warn' | 'error'

export interface ErrorLog {
  write(source: LogSource, level: LogLevel, message: string): void
  /** Resolves when every queued line is on disk (tests, shutdown). */
  flush(): Promise<void>
  /** Deletes day files older than KEEP_DAYS. */
  prune(): void
  readonly dir: string
}

function day(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function createErrorLog(dir: string, now: () => Date = () => new Date()): ErrorLog {
  mkdirSync(dir, { recursive: true })
  let chain: Promise<void> = Promise.resolve()
  let currentDay = ''
  let bytes = 0
  let capped = false

  const append = (file: string, text: string): void => {
    chain = chain.then(
      () =>
        new Promise<void>((resolve) => {
          // A failed write must never throw into the code that logged; it is
          // reported once on stderr through the untouched original.
          appendFile(file, text, 'utf8', (err) => {
            if (err) process.stderr.write(`[error-log] cannot write ${file}: ${err.message}\n`)
            resolve()
          })
        })
    )
  }

  return {
    dir,
    write(source, level, message) {
      const at = now()
      const today = day(at)
      const file = join(dir, `hidock-${today}.log`)
      if (today !== currentDay) {
        currentDay = today
        capped = false
        try {
          bytes = statSync(file).size
        } catch {
          bytes = 0 // no file for today yet
        }
      }
      if (capped) return
      const body = message.length > MAX_ENTRY_CHARS ? `${message.slice(0, MAX_ENTRY_CHARS)} [cut]` : message
      let line = `${at.toISOString()} ${source} ${level} ${body.replace(/\r?\n/g, '\n    ')}\n`
      if (bytes + line.length > MAX_BYTES_PER_DAY) {
        capped = true
        line = `${at.toISOString()} main warn log limit of ${MAX_BYTES_PER_DAY} bytes reached; nothing more is written today\n`
      }
      bytes += line.length
      append(file, line)
    },
    flush() {
      return chain
    },
    prune() {
      const cutoff = day(new Date(now().getTime() - KEEP_DAYS * 86_400_000))
      for (const name of readdirSync(dir)) {
        const m = FILE_RE.exec(name)
        if (m && m[1] < cutoff) unlinkSync(join(dir, name))
      }
    }
  }
}

/**
 * Tee the main process's console.warn and console.error into the log. The
 * original console still gets every call unchanged.
 */
export function teeMainConsole(log: ErrorLog, target: Pick<Console, 'warn' | 'error'> = console): void {
  for (const level of ['warn', 'error'] as const) {
    const original = target[level].bind(target)
    target[level] = (...args: unknown[]) => {
      original(...args)
      try {
        log.write('main', level, format(...args))
      } catch {
        // logging must never break the caller
      }
    }
  }
}

/** The events of a window's webContents this log listens to. */
export interface WindowEvents {
  on(event: 'console-message', listener: (e: { level: string; message: string; lineNumber: number; sourceId: string }) => void): unknown
  on(event: 'render-process-gone', listener: (e: unknown, details: { reason: string; exitCode: number }) => void): unknown
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown
}

/** Window console warnings and errors, a crashed renderer, and a hung window. */
export function logWindow(log: ErrorLog, contents: WindowEvents): void {
  contents.on('console-message', (e) => {
    if (e.level !== 'warning' && e.level !== 'error') return
    const where = e.sourceId ? ` (${e.sourceId.replace(/\?.*$/, '')}:${e.lineNumber})` : ''
    log.write('window', e.level === 'error' ? 'error' : 'warn', `${e.message}${where}`)
  })
  contents.on('render-process-gone', (_e, details) => {
    log.write('window', 'error', `window process gone: ${details.reason} (exit ${details.exitCode})`)
  })
  contents.on('unresponsive', () => log.write('window', 'warn', 'window stopped responding'))
  contents.on('responsive', () => log.write('window', 'warn', 'window responding again'))
}
