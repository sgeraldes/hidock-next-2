// @vitest-environment node

/**
 * The validity pass over a 2,140-row library, timed: the longest main-thread
 * hold while it drains every stale row, with AI meeting links cleared, and a
 * second pass that checks nothing.
 *
 * It lives in a *-responsiveness file so it runs in the `responsiveness`
 * vitest project (one file at a time, after every other project). Inside
 * transcript-validity-store.test.ts it ran beside the other main-db files on
 * two workers and measured them: CI on PR #196 (26-nov) saw a 288 ms pass
 * slice against the 250 ms CI bound.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '', cache: '' }))
paths.db = join(tmpdir(), `hidock-validity-projection-${process.pid}-${Date.now()}.db`)
paths.cache = join(tmpdir(), `hidock-validity-projection-cache-${process.pid}-${Date.now()}`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
  getCachePath: () => paths.cache,
  getTranscriptsPath: () => join(paths.cache, 'transcripts'),
}))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { valueClassificationMinConfidence: 0.6 } }),
}))
const emitDomainEvent = vi.hoisted(() => vi.fn())
vi.mock('../event-bus', () => ({ getEventBus: () => ({ emitDomainEvent }) }))

import { initializeDatabase, closeDatabase, run, runNoSave, saveDatabase } from '../database'
import { backfillTranscriptValidity } from '../transcript-validity-store'
import { autoLinkRecordingsToMeetings } from '../org-reconciler'

beforeAll(async () => {
  await initializeDatabase()
})

afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
  if (existsSync(paths.cache)) rmSync(paths.cache, { recursive: true, force: true })
})

describe('full library projection', () => {
  it('drains 2140 stale rows despite clearing AI meeting links and checks zero next pass', async () => {
    await backfillTranscriptValidity()
    run(`INSERT INTO meetings (id,subject,start_time,end_time,attendees) VALUES ('projection-meeting','Sync','2026-10-05','2026-10-06','[{}]')`)
    for (let i = 0; i < 2140; i++) {
      const id = `projection-${String(i).padStart(4, '0')}`
      runNoSave(`INSERT INTO recordings (id,filename,date_recorded,meeting_id,correlation_method) VALUES (?,?,'2026-10-05','projection-meeting','ai_transcript_match')`, [id, `${id}.hda`])
      runNoSave(`INSERT INTO transcripts (id,recording_id,full_text,speakers,integrity_status,validity_version) VALUES (?,?, 'text','[]','broken',1)`, [`t-${id}`, id])
    }
    saveDatabase()
    // This measures how the pass yields. A commit's fsync costs what the test
    // machine's disk costs (background-pass-responsiveness.test.ts saw 720 ms),
    // so, as there, durability is left to the OS for this temporary file.
    run('PRAGMA synchronous = OFF')
    let worstHoldMs = 0
    let last = performance.now()
    const heartbeat = setInterval(() => { const now = performance.now(); worstHoldMs = Math.max(worstHoldMs, now - last); last = now }, 0)
    const [first, concurrent] = await Promise.all([backfillTranscriptValidity(), backfillTranscriptValidity()])
    clearInterval(heartbeat)
    console.log(`2140-row projection worst hold: ${first.worstHoldMs}ms; heartbeat: ${worstHoldMs}ms`)
    writeFileSync(join(tmpdir(), 'f3-projection-hold.json'), JSON.stringify({ worstHoldMs: first.worstHoldMs, heartbeatMs: worstHoldMs }))
    expect(first.checked).toBe(2140)
    expect(concurrent.checked).toBe(0)
    // The pass's own slices stay under 50 ms on the dev PC (#175's budget;
    // measured 3 to 6 ms). The heartbeat also sees what is not the pass, such
    // as garbage collection after the 2,140-row seed (51 to 60 ms measured while
    // the pass's pages took 1.5 ms, its save 0.1 ms and its event 0.3 ms), so it
    // keeps the 100 ms bound it had. The shared CI runner gets the allowance of
    // background-pass-responsiveness.test.ts (times 5).
    const scale = process.env.CI ? 5 : 1
    expect(first.worstHoldMs).toBeLessThan(50 * scale)
    expect(worstHoldMs).toBeLessThan(100 * scale)
    expect(autoLinkRecordingsToMeetings()).toBe(0)
    expect((await backfillTranscriptValidity()).checked).toBe(0)
    expect(autoLinkRecordingsToMeetings()).toBe(0)
    expect((await backfillTranscriptValidity()).checked).toBe(0)
  }, 120000)
})
