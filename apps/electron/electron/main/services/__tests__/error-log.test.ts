// @vitest-environment node

/**
 * The dated error log: lines on disk in order, one file per day, a daily cap,
 * pruning by age, and the console and window hooks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { createErrorLog, teeMainConsole, logWindow, MAX_BYTES_PER_DAY, MAX_ENTRY_CHARS, type WindowEvents } from '../error-log'

let dir: string
let clock: Date

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hidock-errlog-'))
  clock = new Date(2026, 8, 29, 10, 0, 0)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = (name: string): string => readFileSync(join(dir, name), 'utf8')

describe('error log', () => {
  it('appends lines in order to the day file and indents continuation lines', async () => {
    const log = createErrorLog(dir, () => clock)
    log.write('main', 'warn', 'first')
    log.write('window', 'error', 'boom\n    at Library')
    await log.flush()
    const text = read('hidock-2026-09-29.log')
    const lines = text.trimEnd().split('\n')
    expect(lines[0]).toMatch(/ main warn first$/)
    expect(lines[1]).toMatch(/ window error boom$/)
    expect(lines[2]).toBe('        at Library')
  })

  it('starts a new file on a new day', async () => {
    const log = createErrorLog(dir, () => clock)
    log.write('main', 'error', 'today')
    clock = new Date(2026, 8, 30, 0, 0, 1)
    log.write('main', 'error', 'tomorrow')
    await log.flush()
    expect(read('hidock-2026-09-29.log')).toContain('today')
    expect(read('hidock-2026-09-30.log')).toContain('tomorrow')
  })

  it('cuts long entries and stops at the daily cap with one line saying so', async () => {
    const log = createErrorLog(dir, () => clock)
    log.write('main', 'error', 'x'.repeat(MAX_ENTRY_CHARS + 50))
    await log.flush()
    expect(read('hidock-2026-09-29.log')).toContain('[cut]')

    writeFileSync(join(dir, 'hidock-2026-09-30.log'), 'y'.repeat(MAX_BYTES_PER_DAY - 10))
    clock = new Date(2026, 8, 30, 9, 0, 0)
    const full = createErrorLog(dir, () => clock)
    full.write('main', 'error', 'over the cap')
    full.write('main', 'error', 'after the cap')
    await full.flush()
    const tail = read('hidock-2026-09-30.log').slice(MAX_BYTES_PER_DAY - 10)
    expect(tail).toContain('log limit')
    expect(tail).not.toContain('over the cap')
    expect(tail).not.toContain('after the cap')
  })

  it('prunes day files older than 14 days and nothing else', () => {
    for (const name of ['hidock-2026-09-01.log', 'hidock-2026-09-15.log', 'hidock-2026-09-28.log', 'notes.txt']) {
      writeFileSync(join(dir, name), 'x')
    }
    createErrorLog(dir, () => clock).prune()
    expect(readdirSync(dir).sort()).toEqual(['hidock-2026-09-15.log', 'hidock-2026-09-28.log', 'notes.txt'])
  })

  it('prunes again when the day rolls over while the app stays open', async () => {
    writeFileSync(join(dir, 'hidock-2026-09-15.log'), 'x')
    const log = createErrorLog(dir, () => clock)
    log.write('main', 'warn', 'on the 29th')
    expect(readdirSync(dir)).toContain('hidock-2026-09-15.log')
    clock = new Date(2026, 9, 1, 8, 0, 0) // 1 Oct: the 15th is now older than 14 days
    log.write('main', 'warn', 'on the 1st')
    await log.flush()
    expect(readdirSync(dir)).not.toContain('hidock-2026-09-15.log')
  })

  it('counts the daily cap in bytes, so accented and wide text cannot overshoot it', async () => {
    writeFileSync(join(dir, 'hidock-2026-09-29.log'), 'y'.repeat(MAX_BYTES_PER_DAY - 300))
    const log = createErrorLog(dir, () => clock)
    log.write('main', 'error', 'ñ'.repeat(200)) // 200 characters, 400 bytes
    await log.flush()
    expect(read('hidock-2026-09-29.log')).toContain('log limit')
    expect(read('hidock-2026-09-29.log')).not.toContain('ññ')
  })

  it('wraps a console only once', async () => {
    const log = createErrorLog(dir, () => clock)
    const target = { warn: (..._a: unknown[]) => undefined, error: (..._a: unknown[]) => undefined }
    teeMainConsole(log, target)
    teeMainConsole(log, target)
    target.error('once')
    await log.flush()
    expect(read('hidock-2026-09-29.log').match(/once/g)).toHaveLength(1)
  })

  it('tees console.warn and console.error without changing what the console gets', async () => {
    const log = createErrorLog(dir, () => clock)
    const seen: unknown[][] = []
    const target = { warn: (...a: unknown[]) => void seen.push(a), error: (...a: unknown[]) => void seen.push(a) }
    teeMainConsole(log, target)
    target.warn('[Jensen] stalled', { received: 3 })
    target.error(new Error('bad'))
    await log.flush()
    expect(seen).toHaveLength(2)
    const text = read('hidock-2026-09-29.log')
    expect(text).toContain("main warn [Jensen] stalled { received: 3 }")
    expect(text).toContain('main error Error: bad')
  })

  it('logs window warnings and errors, a crashed window and a hang, and skips info', async () => {
    const log = createErrorLog(dir, () => clock)
    const contents = new EventEmitter()
    logWindow(log, contents as unknown as WindowEvents)
    contents.emit('console-message', { level: 'info', message: 'hello', lineNumber: 1, sourceId: '' })
    contents.emit('console-message', { level: 'error', message: 'Maximum update depth exceeded', lineNumber: 12, sourceId: 'http://localhost:5173/pages/Library.tsx?t=1' })
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    contents.emit('unresponsive')
    await log.flush()
    const text = read('hidock-2026-09-29.log')
    expect(text).not.toContain('hello')
    expect(text).toContain('window error Maximum update depth exceeded (http://localhost:5173/pages/Library.tsx:12)')
    expect(text).toContain('window process gone: crashed (exit 1)')
    expect(text).toContain('window stopped responding')
  })
})
