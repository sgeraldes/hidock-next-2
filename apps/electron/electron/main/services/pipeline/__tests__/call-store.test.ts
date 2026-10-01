/**
 * The call ledger against a real temp database: the migration creates the table, a row round-trips, a
 * call without a recording is stored, deleting the recording removes its rows, and a sink that throws
 * never reaches the caller.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync, readFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-calls-${process.pid}-${Date.now()}.db`)

vi.mock('../../file-storage', () => ({
  getDatabasePath: () => paths.db
}))

import { initializeDatabase, closeDatabase, run, queryAll, runWithMassDeleteAllowed } from '../../database'
import {
  getCallsForRecording,
  getRecentCalls,
  getStepStats,
  installCallStore,
  setCallSink,
  writeCall,
  type CallRecord
} from '../call-store'

const db = { run, queryAll }

const EXPECTED_SCHEMA_VERSION = Number(
  readFileSync(join(__dirname, '..', '..', 'database.ts'), 'utf-8').match(/const SCHEMA_VERSION = (\d+)\b/)![1]
)

function cleanupDbFiles(base: string): void {
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${base}${suffix}`)) rmSync(`${base}${suffix}`, { force: true })
  }
}

function seedRecording(id: string): void {
  run(
    `INSERT INTO recordings (id, filename, date_recorded, status, location, transcription_status, on_device, on_local, source, is_imported)
     VALUES (?, ?, '2026-01-01T10:00:00.000Z', 'none', 'local-only', 'none', 0, 1, 'hidock', 0)`,
    [id, `${id}.wav`]
  )
}

function record(over: Partial<CallRecord> = {}): CallRecord {
  return {
    step: 'notes',
    recordingId: null,
    route: 'router:suggestions:chat',
    provider: 'gemini-api',
    model: 'gemini-3.8-flash',
    status: 'completed',
    startedAt: '2026-09-30T12:00:00.000Z',
    completedAt: '2026-09-30T12:00:02.000Z',
    durationMs: 2000,
    parentCallId: null,
    usage: { calls: 1, tokens: { input: 10, output: 5 } },
    estimatedCostAmount: 0.0001,
    estimatedCostCurrency: 'USD',
    costMethod: 'reported-or-list-price-2026-09-30',
    errorMessage: null,
    ...over
  }
}

describe('pipeline call ledger', () => {
  beforeAll(async () => {
    cleanupDbFiles(paths.db)
    await initializeDatabase()
  })

  afterAll(() => {
    installCallStore(null)
    setCallSink(null)
    closeDatabase()
    cleanupDbFiles(paths.db)
  })

  beforeEach(() => {
    runWithMassDeleteAllowed(() => {
      run('DELETE FROM pipeline_calls')
      run('DELETE FROM recordings')
    })
    installCallStore(db)
  })

  it('the migration creates the table and the schema version is the one in database.ts', () => {
    const columns = queryAll<{ name: string }>('PRAGMA table_info(pipeline_calls)').map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id', 'step', 'recording_id', 'route', 'provider', 'model', 'status', 'started_at', 'completed_at',
        'duration_ms', 'parent_call_id', 'usage_json', 'estimated_cost_amount', 'estimated_cost_currency',
        'cost_method', 'error_message'
      ])
    )
    const row = queryAll<{ version: number }>('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')[0]
    expect(row.version).toBe(EXPECTED_SCHEMA_VERSION)
  })

  it('stores a call without a recording and reads it back', () => {
    const id = writeCall(record())
    expect(id).toEqual(expect.any(String))
    const [stored] = getRecentCalls()
    expect(stored).toMatchObject({
      id,
      step: 'notes',
      recordingId: null,
      provider: 'gemini-api',
      model: 'gemini-3.8-flash',
      status: 'completed',
      durationMs: 2000,
      usage: { calls: 1, tokens: { input: 10, output: 5 } },
      estimatedCostAmount: 0.0001
    })
  })

  it('links a call to its recording, and deleting the recording removes its rows', () => {
    seedRecording('rec-1')
    writeCall(record({ step: 'reformat', recordingId: 'rec-1' }))
    writeCall(record({ step: 'notes' }))
    expect(getCallsForRecording('rec-1').map((c) => c.step)).toEqual(['reformat'])
    runWithMassDeleteAllowed(() => run('DELETE FROM recordings WHERE id = ?', ['rec-1']))
    expect(getCallsForRecording('rec-1')).toEqual([])
    expect(getRecentCalls().map((c) => c.step)).toEqual(['notes'])
  })

  it('stores a failure with its message and no usage', () => {
    writeCall(record({ status: 'failed', usage: null, estimatedCostAmount: null, estimatedCostCurrency: null, costMethod: null, errorMessage: 'empty answer' }))
    expect(getRecentCalls()[0]).toMatchObject({ status: 'failed', usage: null, errorMessage: 'empty answer' })
  })

  it('lists the most recent first and honours the limit', () => {
    writeCall(record({ step: 'first', startedAt: '2026-09-30T10:00:00.000Z', completedAt: '2026-09-30T10:00:01.000Z' }))
    writeCall(record({ step: 'second', startedAt: '2026-09-30T11:00:00.000Z', completedAt: '2026-09-30T11:00:01.000Z' }))
    expect(getRecentCalls(1).map((c) => c.step)).toEqual(['second'])
    expect(getRecentCalls().map((c) => c.step)).toEqual(['second', 'first'])
  })

  it('does nothing without a sink, and swallows a sink that throws', () => {
    setCallSink(null)
    expect(writeCall(record())).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setCallSink(() => {
      throw new Error('disk full')
    })
    expect(writeCall(record())).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    // The same error text is reported once, not once per call.
    expect(writeCall(record())).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('has nothing to read, and says so, when no database is installed', () => {
    installCallStore(null)
    expect(writeCall(record())).toBeNull()
    expect(() => getRecentCalls()).toThrow(/not installed/)
    expect(() => getCallsForRecording('rec-1')).toThrow(/not installed/)
  })

  it('a row for a recording that does not exist fails inside the sink and is reported, not thrown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(writeCall(record({ recordingId: 'no-such-recording' }))).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  describe('getStepStats', () => {
    beforeEach(() => {
      runWithMassDeleteAllowed(() => run('DELETE FROM pipeline_calls'))
      installCallStore(db)
    })

    const at = (iso: string, over: Partial<CallRecord>): CallRecord => record({ startedAt: iso, completedAt: iso, ...over })

    it('is empty without calls', () => {
      expect(getStepStats('2026-09-01T00:00:00.000Z')).toEqual({})
    })

    it('counts calls and failures and takes the median time and cost of the completed ones', () => {
      for (const [ms, cost] of [
        [1000, 0.001],
        [3000, 0.003],
        [2000, 0.002]
      ] as const) {
        writeCall(at('2026-09-30T10:00:00.000Z', { step: 'notes', durationMs: ms, estimatedCostAmount: cost }))
      }
      writeCall(at('2026-09-30T11:00:00.000Z', { step: 'notes', status: 'failed', durationMs: 90000, estimatedCostAmount: null, errorMessage: 'empty answer' }))
      expect(getStepStats('2026-09-01T00:00:00.000Z').notes).toEqual({ calls: 4, failed: 1, medianMs: 2000, medianCostUsd: 0.002 })
    })

    it('does not count a cancelled call as a failure, or its time as a typical one', () => {
      writeCall(at('2026-09-30T10:00:00.000Z', { step: 'chat', durationMs: 1000 }))
      writeCall(at('2026-09-30T10:01:00.000Z', { step: 'chat', status: 'cancelled', durationMs: 60000, errorMessage: 'aborted' }))
      expect(getStepStats('2026-09-01T00:00:00.000Z').chat).toEqual({ calls: 2, failed: 0, medianMs: 1000, medianCostUsd: 0.0001 })
    })

    it('takes the mean of the two middle values for an even count, and null cost when none is priced', () => {
      for (const ms of [1000, 2000, 3000, 4000]) {
        writeCall(at('2026-09-30T10:00:00.000Z', { step: 'chat', durationMs: ms, estimatedCostAmount: null, estimatedCostCurrency: null }))
      }
      expect(getStepStats('2026-09-01T00:00:00.000Z').chat).toMatchObject({ medianMs: 2500, medianCostUsd: null })
    })

    it('has no time for a step whose calls all failed', () => {
      writeCall(at('2026-09-30T10:00:00.000Z', { step: 'outputs', status: 'failed', errorMessage: 'down' }))
      expect(getStepStats('2026-09-01T00:00:00.000Z').outputs).toEqual({ calls: 1, failed: 1, medianMs: null, medianCostUsd: null })
    })

    it('leaves out calls before the window and keeps the steps apart', () => {
      writeCall(at('2026-08-01T10:00:00.000Z', { step: 'notes' }))
      writeCall(at('2026-09-30T10:00:00.000Z', { step: 'reformat' }))
      const stats = getStepStats('2026-09-01T00:00:00.000Z')
      expect(Object.keys(stats)).toEqual(['reformat'])
    })

    it('throws, like the other readers, when no database is installed', () => {
      installCallStore(null)
      expect(() => getStepStats('2026-09-01T00:00:00.000Z')).toThrow()
    })
  })
})
