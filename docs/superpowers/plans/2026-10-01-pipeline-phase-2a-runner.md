# Pipeline Phase 2a: The Text Runner and the Call Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the nine text call sites that already go through the `BrainRouter`, and the three Jev call sites, behind one runner that records every call (step, harness, model, time, tokens, cost) in a new ledger table, with no change in what the app answers.

**Architecture:** A new `pipeline/` layer above the brains holds a ledger (`pipeline_calls`), a step catalog with today's routing as its default plan, a call tracker (usage collector, timing, one ledger row) and `runText`, which resolves a step's plan and runs it: a legacy route (the `BrainRouter` exactly as today) or a named harness with an optional fallback. The call sites stop calling the router or a brain and call `runText` (or `trackCall` when they already choose the brain themselves). Phase 3 replaces the default plans with the owner's configuration; nothing in this phase reads new settings.

**Tech Stack:** TypeScript, Electron main process, better-sqlite3 through `services/database.ts`, vitest (`@vitest-environment node`), `AsyncLocalStorage` (already in `brains/harness-usage.ts`).

**Spec:** `docs/superpowers/specs/2026-09-30-pipeline-design.md` (sections 5, 7, 9 and 13, phase 2), `docs/superpowers/specs/2026-09-30-pipeline-design-inventory.md` (rows 11, 12, 13, 15, 16, 21, 22, 23, 24, 25, 26). Phase 1 (PR #118) provides `brains/harness-usage.ts`, `brains/descriptor.ts`, `pipeline/structured-output.ts` and `pipeline/jev-harness.ts`.

## Decisions for the owner

Three choices depart from the letter of the design. Each is cheap to reverse before building; say which way you want it.

1. The ledger is a new table, `pipeline_calls`, and `processing_runs` stays as it is. The design says "one `processing_runs` row per call". `processing_runs.recording_id` is `NOT NULL` with a cascade, and its `stage` names are the list the reader header shows per recording. Half of the text steps have no recording (the assistant chat, notes, outputs, handover), and twenty new stage names would change what the reader header shows. A separate table takes every call, with `recording_id` nullable, and leaves `processing_runs` and its readers untouched. The Pipeline page of phase 3 reads the median time and cost per step from it. If you prefer `processing_runs`, task 1 becomes a migration that rebuilds that table with a nullable recording and a looser stage list; the other tasks do not change.
2. Phase 2 is split in two plans. This one (2a) covers the twelve call sites that go through the router or through Jev: a runner with a fully tested path for named harnesses and fallback, and today's routing as the default. Plan 2b covers the six sites that call the Gemini SDK directly (the transcript analysis bundle, action detection, the timeline, the LLM value rating, the graph ingest, image description), which each need an equivalence test against the code they replace. Splitting keeps each pull request reviewable and lets 2a's runner be proven on the low-risk sites first.
3. The handover keeps choosing its own brain in this phase. It takes an explicit brain from the UI, checks that it is agentic and logs its label before it runs. Phase 2a records its call and leaves the choice where it is; phase 3 lets the plan pick the default.

## Global Constraints

- Phase 2a changes no answer and no default: with no configuration the app routes every call as it did on 30-sep-2026 (spec section 1, item 6). The only visible addition is data: a row per call in `pipeline_calls`.
- Call sites never choose a provider after this phase; they name a step. The step's plan says where the call goes (spec section 5).
- The fail-closed eligibility gate (`shouldGenerate`) runs immediately before every attempt of every plan, the fallback included; an ineligible source sends nothing and records nothing (spec section 9, step 2; `GenerateOptions.shouldGenerate`).
- A ledger row never holds a prompt or an answer: it holds the step, the route, the harness, the model, the times, the counts and, on failure, the first line of the error capped at 200 characters (spec section 6, rule 5).
- Recording a call must never change the call: a ledger that cannot be written is logged once per error text and the call goes on (spec section 9, step 8).
- Quota, cooldown and the lean invocation stay in the adapters; the runner only asks whether a harness can serve (`BrainRouter.canServe`).
- Code style of the repository: no semicolons, single quotes, two-space indent, tests in a `__tests__` folder next to the code, `@vitest-environment node` on main-process tests, text files end with an empty line. Source files use CRLF line endings; a patch script must read and write them in binary and keep `\r\n`.
- The machine rules of the owner apply to every command: run heavy commands (the full suite, builds) one at a time and prefixed with `lowrun`; never redirect stderr (no `2>&1`, `2>`, `2>/dev/null`), redirect stdout to a file when the output is long; never open a window; never put a key or a token in a command or in a test file.
- Commits carry no attribution lines. Stage explicit paths, never `git add -A`. Before every push run the secret gate: `git grep -Il -e . -- . | grep -v '^.secrets.baseline$' | xargs -n 100 python -m detect_secrets.pre_commit_hook --baseline .secrets.baseline` and expect no output.

## Review Focus

Inputs and conditions the spec implies and no task's happy path exercises. Each line has its test in the task named after it.

1. A ledger that cannot be written (no database yet, a foreign key that fails because the recording was deleted mid-call, a full disk) must not change the outcome of the call. Task 3.
2. A call that throws, is aborted, or returns nothing must leave exactly one row with the right status, and the row must not contain the prompt or the answer even when the error message does. Task 3.
3. The fallback must never see content the first attempt was not allowed to see: an ineligible source, an abort or a cancelled signal ends the step, and the fallback attempt has its own eligibility check. Task 4.
4. The router route must behave exactly as the router alone: same task name, same options object (the existing tests assert it), a null answer is a null answer, and a throw from `generate` in the outputs route reaches the caller as the same error. Tasks 4, 5 and 7.
5. A test that mocks `../brains` with only `getBrainRouter` (the handover and notes tests do) must still work: the runner touches the registry only for a named harness. Task 4.
6. Two calls of different steps running at once must each get their own usage: the collector is per call, and a report made outside any call goes nowhere. Task 3.

## File Structure

New files (under `apps/electron/electron/main/services/`):

| File | Responsibility |
|---|---|
| `pipeline/call-store.ts` | The ledger: `CallRecord`, `writeCall` through a replaceable sink, the database sink and two readers |
| `pipeline/steps.ts` | Step ids, `Profile`, `Plan`, and `DEFAULT_PLANS`: today's routing of each text step |
| `pipeline/plans.ts` | `resolvePlan(step)` with a `setPlanSource` seam for phase 3 |
| `pipeline/track-call.ts` | `trackCall` (usage, time, one row, never throws) and `withCallRecord` (same, rethrows) |
| `pipeline/runner.ts` | `createTextRunner(deps)` and `runText(request)`: resolve, gate, call, fall back |

Modified: `database.ts` (schema version 64, the table, migration 64), `main/index.ts` (install the ledger after the database opens), `brains/brain-router.ts` (`canServe`), `chat-llm.ts`, `rag.ts`, `self-identification.ts`, `speaker-inference.ts`, `meeting-disambiguation.ts`, `transcript-upgrade.ts`, `note-intelligence.ts`, `output-generator.ts`, `handover-service.ts`, `value-classification.ts`, `jev-meeting-match.ts`, and the tests named in each task.

Run tests from `apps/electron` with `lowrun npx vitest run <path>`.

---

### Task 1: The call ledger

**Files:**
- Create: `apps/electron/electron/main/services/pipeline/call-store.ts`
- Create: `apps/electron/electron/main/services/pipeline/__tests__/call-store.test.ts`
- Modify: `apps/electron/electron/main/services/database.ts` (`SCHEMA_VERSION`, the fresh-install schema, migration 64)
- Modify: `apps/electron/electron/main/index.ts`

**Interfaces:**
- Consumes: nothing at import time. The database functions are handed in by `installCallStore`, so that a module which records a call does not pull `database.ts` (and Electron) into its tests.
- Produces:
  - `type CallStatus = 'completed' | 'failed' | 'cancelled'`
  - `interface CallRecord { step: string; recordingId: string | null; route: string; provider: string | null; model: string | null; status: CallStatus; startedAt: string; completedAt: string; durationMs: number; parentCallId: string | null; usage: Record<string, unknown> | null; estimatedCostAmount: number | null; estimatedCostCurrency: string | null; costMethod: string | null; errorMessage: string | null }`
  - `interface StoredCall extends CallRecord { id: string }`
  - `type CallSink = (id: string, record: CallRecord) => void`
  - `setCallSink(next: CallSink | null): void`, `writeCall(record: CallRecord): string | null` (the id, or null when nothing was stored)
  - `interface CallDb { run(sql: string, params?: unknown[]): void; queryAll<T>(sql: string, params?: unknown[]): T[] }`
  - `installCallStore(db: CallDb | null): void` (sets the database sink, or removes it with `null`)
  - `getCallsForRecording(recordingId: string): StoredCall[]`, `getRecentCalls(limit?: number): StoredCall[]` (both throw when no database is installed)

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/main/services/pipeline/__tests__/call-store.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/call-store.test.ts`
Expected: FAIL, "Failed to resolve import '../call-store'".

- [ ] **Step 3: Write the schema, the migration and the store**

In `apps/electron/electron/main/services/database.ts`:

1. Change `const SCHEMA_VERSION = 63` to `const SCHEMA_VERSION = 64`.
2. In the fresh-install schema, right after the `recording_meeting_matches` table (the `CREATE TABLE IF NOT EXISTS recording_meeting_matches (...)` block that starts near line 382 and its closing `);`), add:

```sql
-- One row per AI call a pipeline step makes (phase 2 of the pipeline design). Recording is optional:
-- the assistant chat, notes and outputs have none. A row never holds a prompt or an answer.
CREATE TABLE IF NOT EXISTS pipeline_calls (
    id TEXT PRIMARY KEY,
    step TEXT NOT NULL,
    recording_id TEXT,
    route TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'cancelled')),
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    parent_call_id TEXT,
    usage_json TEXT,
    estimated_cost_amount REAL,
    estimated_cost_currency TEXT,
    cost_method TEXT,
    error_message TEXT,
    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pipeline_calls_step ON pipeline_calls(step, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_calls_recording ON pipeline_calls(recording_id);
```

3. In the migrations object, after migration `63`, add:

```ts
  64: () => {
    // The pipeline call ledger: a new table, no change to existing data.
    console.log('Running migration to schema v64: pipeline_calls')
    getDatabase().run(`CREATE TABLE IF NOT EXISTS pipeline_calls (
    id TEXT PRIMARY KEY,
    step TEXT NOT NULL,
    recording_id TEXT,
    route TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'cancelled')),
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    parent_call_id TEXT,
    usage_json TEXT,
    estimated_cost_amount REAL,
    estimated_cost_currency TEXT,
    cost_method TEXT,
    error_message TEXT,
    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
)`)
    getDatabase().run('CREATE INDEX IF NOT EXISTS idx_pipeline_calls_step ON pipeline_calls(step, started_at DESC)')
    getDatabase().run('CREATE INDEX IF NOT EXISTS idx_pipeline_calls_recording ON pipeline_calls(recording_id)')
    console.log('Migration v64 complete')
  },
```

Create `apps/electron/electron/main/services/pipeline/call-store.ts`:

```ts
/**
 * The ledger of AI calls: one row per call a pipeline step makes, with or without a recording.
 *
 * It exists next to `processing_runs` and does not replace it: a processing run belongs to a recording
 * and names a stage the reader shows; a call belongs to a step and may have no recording (the assistant
 * chat, notes, outputs). The Pipeline page reads the median time and cost of each step from here.
 *
 * Writing is behind a replaceable sink so that code which reaches a call site in a test, or before the
 * database opens, stores nothing and needs no database. `installCallStore(db)` sets the database sink;
 * the main process and the headless brain host call it right after `initializeDatabase()`, handing in
 * `run` and `queryAll`. This module imports nothing from `database.ts`, so a file that records a call
 * does not pull the database (and Electron) into its tests.
 *
 * A row never holds a prompt or an answer. A write that fails is reported once per error text and never
 * thrown: recording a call must not change the call.
 */
import { randomUUID } from 'node:crypto'

export type CallStatus = 'completed' | 'failed' | 'cancelled'

export interface CallRecord {
  step: string
  recordingId: string | null
  /** How the call was routed: `router:chat:chat`, `direct:<profile>`, `jev`, `agentic`. */
  route: string
  provider: string | null
  model: string | null
  status: CallStatus
  startedAt: string
  completedAt: string
  durationMs: number
  parentCallId: string | null
  usage: Record<string, unknown> | null
  estimatedCostAmount: number | null
  estimatedCostCurrency: string | null
  costMethod: string | null
  errorMessage: string | null
}

export interface StoredCall extends CallRecord {
  id: string
}

export type CallSink = (id: string, record: CallRecord) => void

/** The two functions of `services/database.ts` the ledger needs. */
export interface CallDb {
  run(sql: string, params?: unknown[]): void
  queryAll<T>(sql: string, params?: unknown[]): T[]
}

let sink: CallSink | null = null
let installed: CallDb | null = null
const reported = new Set<string>()

export function setCallSink(next: CallSink | null): void {
  sink = next
  reported.clear()
}

/** Store one call. Returns its id, or null when nothing was stored (no sink, or the write failed). */
export function writeCall(record: CallRecord): string | null {
  if (!sink) return null
  const id = randomUUID()
  try {
    sink(id, record)
    return id
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    if (!reported.has(text)) {
      reported.add(text)
      console.warn('[Pipeline] could not record a call:', text)
    }
    return null
  }
}

function insertCall(db: CallDb, id: string, r: CallRecord): void {
  db.run(
    `INSERT INTO pipeline_calls
       (id, step, recording_id, route, provider, model, status, started_at, completed_at, duration_ms,
        parent_call_id, usage_json, estimated_cost_amount, estimated_cost_currency, cost_method, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      r.step,
      r.recordingId,
      r.route,
      r.provider,
      r.model,
      r.status,
      r.startedAt,
      r.completedAt,
      Math.max(0, Math.round(r.durationMs)),
      r.parentCallId,
      r.usage ? JSON.stringify(r.usage) : null,
      r.estimatedCostAmount,
      r.estimatedCostCurrency,
      r.costMethod,
      r.errorMessage
    ]
  )
}

/** Send calls to the database, or stop doing so with null. Call it once, right after `initializeDatabase()`. */
export function installCallStore(db: CallDb | null): void {
  installed = db
  setCallSink(db ? (id, record) => insertCall(db, id, record) : null)
}

function requireDb(): CallDb {
  if (!installed) throw new Error('The call ledger is not installed')
  return installed
}

interface CallRow {
  id: string
  step: string
  recording_id: string | null
  route: string
  provider: string | null
  model: string | null
  status: CallStatus
  started_at: string
  completed_at: string
  duration_ms: number
  parent_call_id: string | null
  usage_json: string | null
  estimated_cost_amount: number | null
  estimated_cost_currency: string | null
  cost_method: string | null
  error_message: string | null
}

function fromRow(row: CallRow): StoredCall {
  let usage: Record<string, unknown> | null = null
  if (row.usage_json) {
    try {
      usage = JSON.parse(row.usage_json) as Record<string, unknown>
    } catch {
      usage = null
    }
  }
  return {
    id: row.id,
    step: row.step,
    recordingId: row.recording_id,
    route: row.route,
    provider: row.provider,
    model: row.model,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    parentCallId: row.parent_call_id,
    usage,
    estimatedCostAmount: row.estimated_cost_amount,
    estimatedCostCurrency: row.estimated_cost_currency,
    costMethod: row.cost_method,
    errorMessage: row.error_message
  }
}

export function getCallsForRecording(recordingId: string): StoredCall[] {
  return requireDb()
    .queryAll<CallRow>('SELECT * FROM pipeline_calls WHERE recording_id = ? ORDER BY started_at ASC', [recordingId])
    .map(fromRow)
}

export function getRecentCalls(limit = 50): StoredCall[] {
  return requireDb().queryAll<CallRow>('SELECT * FROM pipeline_calls ORDER BY started_at DESC LIMIT ?', [limit]).map(fromRow)
}
```

- [ ] **Step 4: Install the ledger at both database entry points**

In `apps/electron/electron/main/index.ts`, add `import { installCallStore } from './services/pipeline/call-store'` with the other service imports, add `run, queryAll` to the existing `import { initializeDatabase, closeDatabase, isGraphProvenanceCleanupRegistered } from './services/database'` line, and right after `console.log('Database initialized')` add:

```ts
  installCallStore({ run, queryAll })
```

The headless brain host (`main/brain-host.ts`) installs no ledger: it opens the database read-only, and the one `initializeDatabase` call in it is the upgrade path, which closes the database again at once. Calls made in that process are not recorded.

- [ ] **Step 5: Run the ledger test and the database tests**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/call-store.test.ts electron/main/services/__tests__/database.test.ts`
Expected: PASS. The existing database test reads `SCHEMA_VERSION` from the source, so it follows 64.

- [ ] **Step 6: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/database.ts apps/electron/electron/main/services/pipeline apps/electron/electron/main/index.ts
git commit -m "Pipeline: a ledger with one row per AI call, with or without a recording"
```

---

### Task 2: Steps, plans and a way to ask the router whether a harness can serve

**Files:**
- Create: `apps/electron/electron/main/services/pipeline/steps.ts`
- Create: `apps/electron/electron/main/services/pipeline/plans.ts`
- Create: `apps/electron/electron/main/services/pipeline/__tests__/plans.test.ts`
- Modify: `apps/electron/electron/main/services/brains/brain-router.ts` (`canServe`)
- Modify: `apps/electron/electron/main/services/brains/__tests__/brain-router.test.ts` (one new `describe`)

**Interfaces:**
- Consumes: `BrainId`, `BrainTask`, `BrainEffort` from `../brains`.
- Produces:
  - `TEXT_STEPS` (readonly tuple) and `type TextStepId`; `OBSERVED_STEPS` and `type StepId`
  - `interface RouterProfile { kind: 'router'; task: BrainTask; mode: 'chat' | 'generate' }`
  - `interface DirectProfile { kind: 'direct'; id: string; harness: BrainId; model?: string; effort?: BrainEffort; temperature?: number; maxTokens?: number }`
  - `type Profile = RouterProfile | DirectProfile`, `interface PlanCall { profile: Profile; onFail?: Profile }`, `interface Plan { calls: readonly [PlanCall] }`
  - `DEFAULT_PLANS: Record<TextStepId, Plan>`
  - `resolvePlan(step: TextStepId): Plan`, `setPlanSource(next: PlanSource | null): void`, `type PlanSource = (step: TextStepId) => Plan | null`
  - `BrainRouter.canServe(id: BrainId, need: BrainCapability): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `apps/electron/electron/main/services/pipeline/__tests__/plans.test.ts`:

```ts
/**
 * The default plan of every text step is today's routing, and a plan source can replace it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest'
import { DEFAULT_PLANS, OBSERVED_STEPS, TEXT_STEPS, type Plan } from '../steps'
import { resolvePlan, setPlanSource } from '../plans'

describe('default plans', () => {
  afterEach(() => setPlanSource(null))

  it('has a plan for every text step and for nothing else', () => {
    expect(Object.keys(DEFAULT_PLANS).sort()).toEqual([...TEXT_STEPS].sort())
    for (const observed of OBSERVED_STEPS) expect(Object.keys(DEFAULT_PLANS)).not.toContain(observed)
  })

  it('routes the chat family through the router chat, as chat-llm does today', () => {
    for (const step of ['chat', 'rag-summarize', 'rag-action-items', 'self-id', 'speaker-roster', 'meeting-pick', 'reformat'] as const) {
      expect(DEFAULT_PLANS[step].calls[0].profile).toEqual({ kind: 'router', task: 'chat', mode: 'chat' })
    }
  })

  it('routes notes through the suggestions task and outputs through resolve then generate', () => {
    expect(DEFAULT_PLANS.notes.calls[0].profile).toEqual({ kind: 'router', task: 'suggestions', mode: 'chat' })
    expect(DEFAULT_PLANS.outputs.calls[0].profile).toEqual({ kind: 'router', task: 'outputs', mode: 'generate' })
  })

  it('has no fallback in any default plan: the router walks its own chain', () => {
    for (const step of TEXT_STEPS) expect(DEFAULT_PLANS[step].calls[0].onFail).toBeUndefined()
  })
})

describe('resolvePlan', () => {
  afterEach(() => setPlanSource(null))

  it('returns the default plan without a source', () => {
    expect(resolvePlan('notes')).toBe(DEFAULT_PLANS.notes)
  })

  it('returns the plan a source gives, and the default when the source has none for that step', () => {
    const custom: Plan = {
      calls: [{ profile: { kind: 'direct', id: 'haiku', harness: 'claude-code', model: 'haiku', effort: 'low' } }]
    }
    setPlanSource((step) => (step === 'notes' ? custom : null))
    expect(resolvePlan('notes')).toBe(custom)
    expect(resolvePlan('chat')).toBe(DEFAULT_PLANS.chat)
  })
})
```

In `brains/__tests__/brain-router.test.ts` add `import { noteBrainFailure, _resetBrainCooldownsForTests } from '../brain-cooldown'` after the `import { OllamaBrain } from '../ollama-brain'` line, and append at the end of the file (it uses the file's own `makeBrain`, `makeRegistry` and `mockBrainsConfig`):

```ts
describe('BrainRouter.canServe', () => {
  beforeEach(() => {
    mockBrainsConfig = { defaultBrain: 'gemini-api', enabled: { 'gemini-api': true, ollama: true, kiro: false, codex: true } }
    _resetBrainCooldownsForTests()
  })

  const build = () =>
    new BrainRouter(
      makeRegistry({
        'gemini-api': makeBrain('gemini-api', ['generate', 'chat'], true),
        ollama: makeBrain('ollama', ['generate', 'chat'], false),
        kiro: makeBrain('kiro', ['generate', 'chat', 'agentic'], true),
        codex: makeBrain('codex', ['generate', 'chat', 'agentic'], true),
      })
    )

  it('is true for an enabled, configured brain that has the capability', async () => {
    expect(await build().canServe('gemini-api', 'chat')).toBe(true)
    expect(await build().canServe('codex', 'agentic')).toBe(true)
  })

  it('is false for a brain that is not configured, disabled, unregistered or without the capability', async () => {
    const router = build()
    expect(await router.canServe('ollama', 'chat')).toBe(false) // not configured
    expect(await router.canServe('kiro', 'chat')).toBe(false) // disabled in the config
    expect(await router.canServe('claude-code', 'chat')).toBe(false) // not registered
    expect(await router.canServe('gemini-api', 'agentic')).toBe(false) // lacks the capability
  })

  it('is false while the brain rests after an out-of-quota failure', async () => {
    noteBrainFailure('codex', 'usage limit reached|4102444800')
    expect(await build().canServe('codex', 'chat')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/plans.test.ts electron/main/services/brains/__tests__/brain-router.test.ts`
Expected: FAIL, "Failed to resolve import '../steps'" and "router.canServe is not a function".

- [ ] **Step 3: Write `steps.ts`, `plans.ts` and `canServe`**

Create `apps/electron/electron/main/services/pipeline/steps.ts`:

```ts
/**
 * The steps phase 2a runs and the plan each one has by default.
 *
 * A step is what the owner will configure in Settings (design section 3). Phase 2a knows the text steps
 * that go through `runText` and the steps whose call it only records (`OBSERVED_STEPS`: the handover
 * chooses its own brain, and the Jev steps are not text).
 *
 * A profile is where a call goes. A `router` profile is today's routing, kept exactly: the BrainRouter
 * decides, walks its own chain and applies its own eligibility gates. A `direct` profile names a harness,
 * a model and settings (phase 3 builds these from the owner's configuration). Default plans are all
 * router profiles, so with no configuration nothing moves.
 */
import type { BrainEffort, BrainId, BrainTask } from '../brains'

export const TEXT_STEPS = [
  'chat',
  'rag-summarize',
  'rag-action-items',
  'self-id',
  'speaker-roster',
  'meeting-pick',
  'reformat',
  'notes',
  'outputs'
] as const
export type TextStepId = (typeof TEXT_STEPS)[number]

export const OBSERVED_STEPS = ['handover', 'evaluate', 'meeting-match', 'speaker-names'] as const
export type StepId = TextStepId | (typeof OBSERVED_STEPS)[number]

/** Today's routing: `chat` walks the router's chat chain; `generate` resolves one brain and calls it once. */
export interface RouterProfile {
  kind: 'router'
  task: BrainTask
  mode: 'chat' | 'generate'
}

export interface DirectProfile {
  kind: 'direct'
  /** The profile's name, shown in the ledger. */
  id: string
  harness: BrainId
  model?: string
  effort?: BrainEffort
  temperature?: number
  maxTokens?: number
}

export type Profile = RouterProfile | DirectProfile

export interface PlanCall {
  profile: Profile
  /** Tried once when the profile is unavailable, answers nothing or fails. Not tried for an abort or an ineligible source. */
  onFail?: Profile
}

/** Phase 2a: one pass with one call. Stacked and parallel shapes come with phase 5. */
export interface Plan {
  calls: readonly [PlanCall]
}

const chatRoute = (task: BrainTask): Plan => ({ calls: [{ profile: { kind: 'router', task, mode: 'chat' } }] })

export const DEFAULT_PLANS: Record<TextStepId, Plan> = {
  chat: chatRoute('chat'),
  'rag-summarize': chatRoute('chat'),
  'rag-action-items': chatRoute('chat'),
  'self-id': chatRoute('chat'),
  'speaker-roster': chatRoute('chat'),
  'meeting-pick': chatRoute('chat'),
  reformat: chatRoute('chat'),
  notes: chatRoute('suggestions'),
  outputs: { calls: [{ profile: { kind: 'router', task: 'outputs', mode: 'generate' } }] }
}
```

Create `apps/electron/electron/main/services/pipeline/plans.ts`:

```ts
/**
 * Which plan a step runs. Phase 2a has no configuration, so the answer is the default plan; phase 3
 * installs a source that reads the owner's `pipeline` settings and returns null for a step the owner has
 * not changed.
 */
import { DEFAULT_PLANS, type Plan, type TextStepId } from './steps'

export type PlanSource = (step: TextStepId) => Plan | null

let source: PlanSource | null = null

export function setPlanSource(next: PlanSource | null): void {
  source = next
}

export function resolvePlan(step: TextStepId): Plan {
  return source?.(step) ?? DEFAULT_PLANS[step]
}
```

In `brains/brain-router.ts`, add this public method after `resolve` (it reuses the private `isUsable`, so a named harness is judged exactly like a routed one: enabled, not resting, has the capability, configured):

```ts
  /** Can this brain serve `need` right now? Same test as `resolve`: enabled, not resting, capable, configured. */
  async canServe(id: BrainId, need: BrainCapability): Promise<boolean> {
    return this.isUsable(this.registry.get(id), need)
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/plans.test.ts electron/main/services/brains/__tests__/brain-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/pipeline apps/electron/electron/main/services/brains/brain-router.ts apps/electron/electron/main/services/brains/__tests__/brain-router.test.ts
git commit -m "Pipeline: the text steps, today's routing as their default plan, and canServe on the router"
```

---
### Task 3: Tracking a call

**Files:**
- Create: `apps/electron/electron/main/services/pipeline/track-call.ts`
- Create: `apps/electron/electron/main/services/pipeline/__tests__/track-call.test.ts`

**Interfaces:**
- Consumes: `createHarnessUsageCollector`, `harnessRunFields` from `../brains/harness-usage` (phase 1); `writeCall` from `./call-store`; `StepId` from `./steps`.
- Produces:
  - `interface CallMeta { step: StepId; recordingId?: string | null; route: string; parentCallId?: string | null }`
  - `type Judge<T> = (value: T) => string | null` (a failure message when the value counts as a failed call)
  - `type TrackedCall<T> = { ok: true; value: T; callId: string | null; provider: string | null } | { ok: false; error: unknown; callId: string | null; provider: string | null }`
  - `trackCall<T>(meta: CallMeta, fn: () => Promise<T>, judge?: Judge<T>): Promise<TrackedCall<T>>` (never throws)
  - `withCallRecord<T>(meta: CallMeta, fn: () => Promise<T>, judge?: Judge<T>): Promise<T>` (same, rethrows the error of `fn`)
  - `describeError(error: unknown): string`

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/main/services/pipeline/__tests__/track-call.test.ts`:

```ts
/**
 * trackCall: run a call inside a usage collector, time it, leave exactly one ledger row, and never change
 * what the call returns or throws.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordHarnessUsage } from '../../brains/harness-usage'
import { setCallSink, type CallRecord } from '../call-store'
import { describeError, trackCall, withCallRecord } from '../track-call'

let rows: Array<{ id: string; record: CallRecord }>

beforeEach(() => {
  rows = []
  setCallSink((id, record) => {
    rows.push({ id, record })
  })
})

afterEach(() => {
  setCallSink(null)
  vi.useRealTimers()
})

describe('trackCall', () => {
  it('returns the value and stores a completed row with the usage the call reported', async () => {
    const result = await trackCall({ step: 'notes', route: 'router:suggestions:chat' }, async () => {
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 1000, outputTokens: 200, durationMs: 900 })
      return 'answer'
    })
    expect(result).toMatchObject({ ok: true, value: 'answer', provider: 'gemini-api', callId: rows[0].id })
    expect(rows).toHaveLength(1)
    expect(rows[0].record).toMatchObject({
      step: 'notes',
      recordingId: null,
      route: 'router:suggestions:chat',
      provider: 'gemini-api',
      model: 'gemini-3.8-flash',
      status: 'completed',
      parentCallId: null,
      errorMessage: null,
      estimatedCostCurrency: 'USD'
    })
    expect(rows[0].record.usage).toMatchObject({ calls: 1, tokens: { input: 1000, output: 200 } })
    expect(rows[0].record.estimatedCostAmount).toBeGreaterThan(0)
  })

  it('measures the time of the call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'))
    const pending = trackCall({ step: 'notes', route: 'r' }, () => new Promise<string>((resolve) => setTimeout(() => resolve('x'), 1500)))
    await vi.advanceTimersByTimeAsync(1500)
    await pending
    expect(rows[0].record.durationMs).toBe(1500)
    expect(rows[0].record.startedAt).toBe('2026-09-30T12:00:00.000Z')
    expect(rows[0].record.completedAt).toBe('2026-09-30T12:00:01.500Z')
  })

  it('carries the recording and the parent call through to the row', async () => {
    await trackCall({ step: 'reformat', route: 'direct:haiku', recordingId: 'rec-1', parentCallId: 'call-0' }, async () => 'x')
    expect(rows[0].record).toMatchObject({ recordingId: 'rec-1', parentCallId: 'call-0' })
  })

  it('stores a call with no reported usage, with the route as the only provenance', async () => {
    await trackCall({ step: 'outputs', route: 'router:outputs:generate' }, async () => 'x')
    expect(rows[0].record).toMatchObject({ provider: null, model: null, usage: null, estimatedCostAmount: null, status: 'completed' })
  })

  it('marks the call failed, with the judge message, when the judge refuses the value, and still returns the value', async () => {
    const result = await trackCall({ step: 'notes', route: 'r' }, async () => null as string | null, (v) => (v == null ? 'empty answer' : null))
    expect(result).toMatchObject({ ok: true, value: null })
    expect(rows[0].record).toMatchObject({ status: 'failed', errorMessage: 'empty answer' })
  })

  it('records a throw as failed, returns it without throwing, and keeps only the first line of the message', async () => {
    const boom = new Error('Bad request\nprompt: the private transcript text')
    const result = await trackCall({ step: 'outputs', route: 'r' }, async () => {
      throw boom
    })
    expect(result).toMatchObject({ ok: false, error: boom })
    expect(rows[0].record.status).toBe('failed')
    expect(rows[0].record.errorMessage).toBe('Error: Bad request')
    expect(JSON.stringify(rows[0].record)).not.toContain('private transcript')
  })

  it('caps the error message at 200 characters', () => {
    expect(describeError(new Error('x'.repeat(500))).length).toBe(200)
    expect(describeError('plain text')).toBe('plain text')
  })

  it('records an abort as cancelled', async () => {
    await trackCall({ step: 'chat', route: 'r' }, async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    expect(rows[0].record.status).toBe('cancelled')
  })

  it('gives two calls that run at once their own usage', async () => {
    await Promise.all([
      trackCall({ step: 'notes', route: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5))
        recordHarnessUsage({ harness: 'ollama', model: 'qwen3:8b', inputTokens: 10, durationMs: 5 })
        return 1
      }),
      trackCall({ step: 'outputs', route: 'b' }, async () => {
        recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 99, durationMs: 1 })
        await new Promise((r) => setTimeout(r, 10))
        return 2
      })
    ])
    const byStep = Object.fromEntries(rows.map((r) => [r.record.step, r.record]))
    expect(byStep.notes.provider).toBe('ollama')
    expect((byStep.notes.usage as { tokens: { input: number } }).tokens.input).toBe(10)
    expect(byStep.outputs.provider).toBe('gemini-api')
    expect((byStep.outputs.usage as { tokens: { input: number } }).tokens.input).toBe(99)
  })

  it('does not change the outcome when the ledger cannot be written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setCallSink(() => {
      throw new Error('disk full')
    })
    const result = await trackCall({ step: 'notes', route: 'r' }, async () => 'answer')
    expect(result).toMatchObject({ ok: true, value: 'answer', callId: null })
  })
})

describe('withCallRecord', () => {
  it('returns the value and records the call', async () => {
    expect(await withCallRecord({ step: 'handover', route: 'agentic' }, async () => 'done')).toBe('done')
    expect(rows).toHaveLength(1)
  })

  it('records the failure and throws the same error', async () => {
    const boom = new Error('provider down')
    await expect(
      withCallRecord({ step: 'evaluate', route: 'jev' }, async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(rows[0].record.status).toBe('failed')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/track-call.test.ts`
Expected: FAIL, "Failed to resolve import '../track-call'".

- [ ] **Step 3: Write `track-call.ts`**

Create `apps/electron/electron/main/services/pipeline/track-call.ts`:

```ts
/**
 * Run one AI call and leave one row in the ledger for it.
 *
 * The call runs inside its own usage collector, so whatever the adapters report while it runs (tokens,
 * model, time, a cost the CLI states) lands on this call and on no other, however many run at once. The
 * row gets the harness and model that reported, the cost estimate from `harnessRunFields`, and on failure
 * the first line of the error capped at 200 characters: an error text can echo a prompt, and the ledger
 * never holds one.
 *
 * `trackCall` never throws and returns the failure as a value, so a runner can decide what a failure
 * means. `withCallRecord` is for a call site that already handles failure by exception and only wants the
 * call recorded.
 */
import { createHarnessUsageCollector, harnessRunFields } from '../brains/harness-usage'
import { writeCall, type CallStatus } from './call-store'
import type { StepId } from './steps'

export interface CallMeta {
  step: StepId
  recordingId?: string | null
  /** How the call was routed, for the ledger: `router:chat:chat`, `direct:<profile>`, `jev`, `agentic`. */
  route: string
  /** The call that failed just before this one when this is a fallback attempt. */
  parentCallId?: string | null
}

/** A failure message when the value should count as a failed call (an empty answer), otherwise null. */
export type Judge<T> = (value: T) => string | null

export type TrackedCall<T> =
  | { ok: true; value: T; callId: string | null; provider: string | null }
  | { ok: false; error: unknown; callId: string | null; provider: string | null }

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError'

export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.split(/\r?\n/)[0].slice(0, 200)
}

export async function trackCall<T>(meta: CallMeta, fn: () => Promise<T>, judge?: Judge<T>): Promise<TrackedCall<T>> {
  const collector = createHarnessUsageCollector()
  const started = new Date()
  let status: CallStatus = 'completed'
  let errorMessage: string | null = null
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }

  try {
    const value = await collector.run(fn)
    const refusal = judge?.(value) ?? null
    if (refusal) {
      status = 'failed'
      errorMessage = refusal
    }
    outcome = { ok: true, value }
  } catch (error) {
    status = isAbort(error) ? 'cancelled' : 'failed'
    errorMessage = describeError(error)
    outcome = { ok: false, error }
  }

  const total = collector.total()
  const reporter = total ? Object.values(total.byModel)[0] : undefined
  const fields = harnessRunFields(total)
  const completed = new Date()
  const callId = writeCall({
    step: meta.step,
    recordingId: meta.recordingId ?? null,
    route: meta.route,
    provider: reporter?.harness ?? null,
    model: reporter && reporter.model !== 'unknown' ? reporter.model : null,
    status,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: completed.getTime() - started.getTime(),
    parentCallId: meta.parentCallId ?? null,
    usage: fields.usage ?? null,
    estimatedCostAmount: fields.estimatedCostAmount ?? null,
    estimatedCostCurrency: fields.estimatedCostCurrency ?? null,
    costMethod: fields.costMethod ?? null,
    errorMessage
  })

  const provider = reporter?.harness ?? null
  return outcome.ok ? { ok: true, value: outcome.value, callId, provider } : { ok: false, error: outcome.error, callId, provider }
}

export async function withCallRecord<T>(meta: CallMeta, fn: () => Promise<T>, judge?: Judge<T>): Promise<T> {
  const tracked = await trackCall(meta, fn, judge)
  if (!tracked.ok) throw tracked.error
  return tracked.value
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/track-call.test.ts`
Expected: PASS, 12 tests. If the cost assertion fails because `gemini-3.8-flash` has no listed price, use a model that `GEMINI_PRICES` in `gemini-usage.ts` lists (the phase 1 tests use `gemini-3.8-flash` and it is listed); do not loosen the assertion.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/pipeline
git commit -m "Pipeline: track a call with its usage, time and one ledger row, without changing what it returns"
```

---

### Task 4: The text runner

**Files:**
- Create: `apps/electron/electron/main/services/pipeline/runner.ts`
- Create: `apps/electron/electron/main/services/pipeline/__tests__/runner.test.ts`

**Interfaces:**
- Consumes: `resolvePlan` (Task 2), `trackCall`, `CallMeta`, `Judge`, `TrackedCall` (Task 3), `eligibleToGenerate` from `../brains/eligibility`, `getBrainRouter`, `getBrainRegistry`, `BrainRouter`, `BrainRegistry`, `BrainMessage`, `GenerateOptions` from `../brains`.
- Produces:
  - `interface TextRequest { step: TextStepId; messages: BrainMessage[]; options?: GenerateOptions; recordingId?: string | null }`
  - `type TextFailure = 'empty' | 'unavailable' | 'ineligible' | 'error'`
  - `type TextOutcome = { ok: true; text: string; provider: string | null; callId: string | null } | { ok: false; reason: TextFailure; error?: unknown; callId: string | null }`
  - `interface RunnerDeps { router: Pick<BrainRouter, 'chat' | 'resolve' | 'canServe'>; registry: Pick<BrainRegistry, 'get'>; planFor: (step: TextStepId) => Plan; track: typeof trackCall }`
  - `createTextRunner(deps: RunnerDeps): (request: TextRequest) => Promise<TextOutcome>`
  - `runText(request: TextRequest): Promise<TextOutcome>` (the runner over the real router, registry and plans)

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/main/services/pipeline/__tests__/runner.test.ts`:

```ts
/**
 * The text runner over fake routers and brains: the router route behaves as the router alone, a named
 * harness gets the profile's settings, a fallback runs once and never sees what the first attempt was not
 * allowed to see, and every attempt leaves one row.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AIBrain, BrainMessage } from '../../brains'
import { recordHarnessUsage } from '../../brains/harness-usage'
import { setCallSink, type CallRecord } from '../call-store'
import { createTextRunner, type RunnerDeps } from '../runner'
import type { Plan, TextStepId } from '../steps'
import { trackCall } from '../track-call'

const MESSAGES: BrainMessage[] = [{ role: 'user', content: 'hello' }]

let rows: Array<{ id: string; record: CallRecord }>

function fakeBrain(id: string, reply: () => Promise<string | null>): AIBrain {
  return {
    id,
    label: id,
    capabilities: () => new Set(['generate', 'chat']),
    authStatus: async () => ({ configured: true, method: 'none' }),
    generate: vi.fn(reply),
    chat: vi.fn(reply)
  } as unknown as AIBrain
}

function makeDeps(over: {
  plan?: Plan
  chat?: () => Promise<string | null>
  resolved?: AIBrain | null
  brains?: Record<string, AIBrain>
  canServe?: (id: string) => boolean
} = {}): RunnerDeps & { router: { chat: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn>; canServe: ReturnType<typeof vi.fn> } } {
  const router = {
    chat: vi.fn(over.chat ?? (async () => 'router answer')),
    resolve: vi.fn(async () => over.resolved ?? null),
    canServe: vi.fn(async (id: string) => (over.canServe ? over.canServe(id) : true))
  }
  const plan: Plan = over.plan ?? { calls: [{ profile: { kind: 'router', task: 'chat', mode: 'chat' } }] }
  return {
    router: router as never,
    registry: { get: (id: string) => over.brains?.[id] ?? null } as never,
    planFor: (_step: TextStepId) => plan,
    track: trackCall
  } as RunnerDeps & { router: typeof router }
}

beforeEach(() => {
  rows = []
  setCallSink((id, record) => {
    rows.push({ id, record })
  })
})

afterEach(() => setCallSink(null))

describe('router route, chat mode (today\'s chat)', () => {
  it('passes the task, the messages and the options object to the router, and returns its answer', async () => {
    const deps = makeDeps({
      plan: { calls: [{ profile: { kind: 'router', task: 'suggestions', mode: 'chat' } }] },
      chat: async () => {
        recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 50, outputTokens: 10, durationMs: 400 })
        return 'the answer'
      }
    })
    const options = { systemPrompt: 'sys', temperature: 0.2, maxTokens: 500 }
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES, options })
    expect(outcome).toMatchObject({ ok: true, text: 'the answer', provider: 'gemini-api' })
    expect(deps.router.chat).toHaveBeenCalledWith('suggestions', MESSAGES, options)
    expect(rows).toHaveLength(1)
    expect(rows[0].record).toMatchObject({ step: 'notes', route: 'router:suggestions:chat', provider: 'gemini-api', status: 'completed' })
  })

  it('treats null and the empty string as no answer, and leaves a failed row', async () => {
    for (const reply of [null, '']) {
      rows.length = 0
      const outcome = await createTextRunner(makeDeps({ chat: async () => reply }))({ step: 'chat', messages: MESSAGES })
      expect(outcome).toMatchObject({ ok: false, reason: 'empty' })
      expect(rows[0].record).toMatchObject({ status: 'failed', errorMessage: 'empty answer' })
    }
  })

  it('passes a whitespace-only answer through, as the callers see it today', async () => {
    const outcome = await createTextRunner(makeDeps({ chat: async () => '  ' }))({ step: 'chat', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: true, text: '  ' })
  })

  it('reports a throw as an error outcome that carries the original error', async () => {
    const boom = new Error('router bug')
    const outcome = await createTextRunner(
      makeDeps({
        chat: async () => {
          throw boom
        }
      })
    )({ step: 'chat', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: false, reason: 'error', error: boom })
    expect(rows[0].record.status).toBe('failed')
  })

  it('links the row to the recording', async () => {
    await createTextRunner(makeDeps())({ step: 'reformat', messages: MESSAGES, recordingId: 'rec-9' })
    expect(rows[0].record.recordingId).toBe('rec-9')
  })
})

describe('router route, generate mode (today\'s outputs)', () => {
  const plan: Plan = { calls: [{ profile: { kind: 'router', task: 'outputs', mode: 'generate' } }] }

  it('resolves one brain and calls its generate with the caller\'s options', async () => {
    const brain = fakeBrain('gemini-api', async () => 'document')
    const deps = makeDeps({ plan, resolved: brain })
    const options = { systemPrompt: 'write well' }
    const outcome = await createTextRunner(deps)({ step: 'outputs', messages: MESSAGES, options })
    expect(outcome).toMatchObject({ ok: true, text: 'document' })
    expect(deps.router.resolve).toHaveBeenCalledWith('outputs', 'generate')
    expect(brain.generate).toHaveBeenCalledWith(MESSAGES, options)
    expect(rows[0].record.route).toBe('router:outputs:generate')
  })

  it('is unavailable when no brain resolves, and records nothing', async () => {
    const outcome = await createTextRunner(makeDeps({ plan, resolved: null }))({ step: 'outputs', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', callId: null })
    expect(rows).toHaveLength(0)
  })

  it('is ineligible, sends nothing and records nothing, when the gate says the source changed', async () => {
    const brain = fakeBrain('gemini-api', async () => 'document')
    const outcome = await createTextRunner(makeDeps({ plan, resolved: brain }))({
      step: 'outputs',
      messages: MESSAGES,
      options: { shouldGenerate: () => false }
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'ineligible' })
    expect(brain.generate).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0)
  })

  it('treats a gate that throws as ineligible (fail closed)', async () => {
    const brain = fakeBrain('gemini-api', async () => 'document')
    const outcome = await createTextRunner(makeDeps({ plan, resolved: brain }))({
      step: 'outputs',
      messages: MESSAGES,
      options: {
        shouldGenerate: () => {
          throw new Error('db gone')
        }
      }
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'ineligible' })
    expect(brain.generate).not.toHaveBeenCalled()
  })

  it('hands a provider error to the caller unchanged', async () => {
    const boom = new Error('API 500')
    const brain = fakeBrain('gemini-api', async () => {
      throw boom
    })
    const outcome = await createTextRunner(makeDeps({ plan, resolved: brain }))({ step: 'outputs', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: false, reason: 'error', error: boom })
    expect(rows[0].record.status).toBe('failed')
  })
})

describe('named harness', () => {
  const haiku = { kind: 'direct', id: 'claude-haiku', harness: 'claude-code', model: 'haiku', effort: 'low', temperature: 0, maxTokens: 300 } as const
  const local = { kind: 'direct', id: 'local-qwen', harness: 'ollama', model: 'qwen3:8b' } as const

  it('calls the harness with the profile\'s settings over the caller\'s, and records the route', async () => {
    const claude = fakeBrain('claude-code', async () => 'claude answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku }] }, brains: { 'claude-code': claude } })
    const outcome = await createTextRunner(deps)({
      step: 'notes',
      messages: MESSAGES,
      options: { systemPrompt: 'sys', temperature: 0.7, maxTokens: 1024 }
    })
    expect(outcome).toMatchObject({ ok: true, text: 'claude answer' })
    expect(claude.chat).toHaveBeenCalledWith(MESSAGES, {
      systemPrompt: 'sys',
      temperature: 0,
      maxTokens: 300,
      model: 'haiku',
      effort: 'low'
    })
    expect(deps.router.canServe).toHaveBeenCalledWith('claude-code', 'chat')
    expect(rows[0].record.route).toBe('direct:claude-haiku')
  })

  it('keeps the caller\'s settings where the profile sets none', async () => {
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: local }] }, brains: { ollama } })
    await createTextRunner(deps)({ step: 'notes', messages: MESSAGES, options: { temperature: 0.2, maxTokens: 500 } })
    expect(ollama.chat).toHaveBeenCalledWith(MESSAGES, { temperature: 0.2, maxTokens: 500, model: 'qwen3:8b' })
  })

  it('is unavailable when the router says the harness cannot serve, and the harness is not called', async () => {
    const claude = fakeBrain('claude-code', async () => 'x')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku }] }, brains: { 'claude-code': claude }, canServe: () => false })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(claude.chat).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0)
  })

  it('is unavailable when the registry has no such brain', async () => {
    const deps = makeDeps({ plan: { calls: [{ profile: haiku }] } })
    expect(await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('does not touch the registry for a router route', async () => {
    const deps = makeDeps()
    deps.registry = {
      get: () => {
        throw new Error('the registry must not be read')
      }
    } as never
    expect(await createTextRunner(deps)({ step: 'chat', messages: MESSAGES })).toMatchObject({ ok: true })
  })
})

describe('fallback', () => {
  const haiku = { kind: 'direct', id: 'claude-haiku', harness: 'claude-code', model: 'haiku' } as const
  const local = { kind: 'direct', id: 'local-qwen', harness: 'ollama', model: 'qwen3:8b' } as const

  it('runs the fallback when the first profile answers nothing, and links the two rows', async () => {
    const claude = fakeBrain('claude-code', async () => null)
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: true, text: 'local answer' })
    expect(rows.map((r) => r.record.route)).toEqual(['direct:claude-haiku', 'direct:local-qwen'])
    expect(rows[1].record.parentCallId).toBe(rows[0].id)
  })

  it('runs the fallback when the first harness is unavailable, with no parent because nothing was called', async () => {
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({
      plan: { calls: [{ profile: haiku, onFail: local }] },
      brains: { ollama },
      canServe: (id) => id === 'ollama'
    })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })
    expect(outcome).toMatchObject({ ok: true, text: 'local answer' })
    expect(rows).toHaveLength(1)
    expect(rows[0].record.parentCallId).toBeNull()
  })

  it('runs the fallback after an error', async () => {
    const claude = fakeBrain('claude-code', async () => {
      throw new Error('crashed')
    })
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    expect(await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })).toMatchObject({ ok: true, text: 'local answer' })
  })

  it('does not run the fallback when the source became ineligible', async () => {
    const claude = fakeBrain('claude-code', async () => 'x')
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES, options: { shouldGenerate: () => false } })
    expect(outcome).toMatchObject({ ok: false, reason: 'ineligible' })
    expect(ollama.chat).not.toHaveBeenCalled()
  })

  it('checks the gate again before the fallback, so a source excluded meanwhile is not sent to it', async () => {
    const claude = fakeBrain('claude-code', async () => null)
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    let checks = 0
    const outcome = await createTextRunner(deps)({
      step: 'notes',
      messages: MESSAGES,
      options: { shouldGenerate: () => ++checks === 1 }
    })
    expect(claude.chat).toHaveBeenCalledTimes(1)
    expect(ollama.chat).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: false, reason: 'ineligible' })
  })

  it('does not run the fallback after the caller aborted', async () => {
    const controller = new AbortController()
    const claude = fakeBrain('claude-code', async () => {
      controller.abort()
      return null
    })
    const ollama = fakeBrain('ollama', async () => 'local answer')
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    const outcome = await createTextRunner(deps)({ step: 'notes', messages: MESSAGES, options: { signal: controller.signal } })
    expect(outcome.ok).toBe(false)
    expect(ollama.chat).not.toHaveBeenCalled()
  })

  it('returns the fallback\'s failure when both fail', async () => {
    const claude = fakeBrain('claude-code', async () => null)
    const ollama = fakeBrain('ollama', async () => null)
    const deps = makeDeps({ plan: { calls: [{ profile: haiku, onFail: local }] }, brains: { 'claude-code': claude, ollama } })
    expect(await createTextRunner(deps)({ step: 'notes', messages: MESSAGES })).toMatchObject({ ok: false, reason: 'empty' })
    expect(rows).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/runner.test.ts`
Expected: FAIL, "Failed to resolve import '../runner'".

- [ ] **Step 3: Write `runner.ts`**

Create `apps/electron/electron/main/services/pipeline/runner.ts`:

```ts
/**
 * The text runner (pipeline design, section 9, phase 2a).
 *
 * `runText` takes a step, resolves its plan and runs the plan's one call:
 *   - a `router` profile is today's routing, untouched: the BrainRouter picks the brain, walks its chain
 *     and applies its own gates (chat mode), or resolves one brain that is then called once (generate mode);
 *   - a `direct` profile names a harness, which must be able to serve; the profile's model, effort,
 *     temperature and limit win over the caller's, and the caller's fill the gaps.
 * If the call answers nothing, fails, or its harness is unavailable, the plan's `onFail` profile runs once.
 * Not after an abort, and not for an ineligible source.
 *
 * The eligibility gate (`options.shouldGenerate`) runs right before every attempt that reaches a
 * provider, the fallback included; false or a throw means the source is ineligible and nothing is sent.
 * Every attempt that calls a provider leaves one row in the ledger (see track-call.ts); an attempt that
 * never reached one (unavailable, ineligible) leaves none.
 *
 * The outcome is a value. The call sites translate it into what they did before: null for an empty
 * answer, the original error rethrown for `error`, their own messages for the rest.
 */
import {
  getBrainRegistry,
  getBrainRouter,
  type BrainMessage,
  type BrainRegistry,
  type BrainRouter,
  type GenerateOptions
} from '../brains'
import { eligibleToGenerate } from '../brains/eligibility'
import { resolvePlan } from './plans'
import type { DirectProfile, Plan, Profile, TextStepId } from './steps'
import { trackCall, type CallMeta, type Judge, type TrackedCall } from './track-call'

export interface TextRequest {
  step: TextStepId
  messages: BrainMessage[]
  /** What the call site needs: prompt, temperature, limit, signal, gate. A named harness's own settings win. */
  options?: GenerateOptions
  recordingId?: string | null
}

export type TextFailure = 'empty' | 'unavailable' | 'ineligible' | 'error'

export type TextOutcome =
  | { ok: true; text: string; provider: string | null; callId: string | null }
  | { ok: false; reason: TextFailure; error?: unknown; callId: string | null }

export interface RunnerDeps {
  router: Pick<BrainRouter, 'chat' | 'resolve' | 'canServe'>
  registry: Pick<BrainRegistry, 'get'>
  planFor: (step: TextStepId) => Plan
  track: typeof trackCall
}

/** null and '' are no answer; a string of spaces is an answer, as the call sites treat it today. */
const emptyAnswer: Judge<string | null> = (value) => (value == null || value === '' ? 'empty answer' : null)

const ineligible = (): TextOutcome => ({ ok: false, reason: 'ineligible', callId: null })
const unavailable = (): TextOutcome => ({ ok: false, reason: 'unavailable', callId: null })

function settle(tracked: TrackedCall<string | null>): TextOutcome {
  if (!tracked.ok) return { ok: false, reason: 'error', error: tracked.error, callId: tracked.callId }
  const text = tracked.value
  if (text == null || text === '') return { ok: false, reason: 'empty', callId: tracked.callId }
  return { ok: true, text, provider: tracked.provider, callId: tracked.callId }
}

function withProfile(options: GenerateOptions, profile: DirectProfile): GenerateOptions {
  return {
    ...options,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {})
  }
}

async function runOne(deps: RunnerDeps, profile: Profile, request: TextRequest, parentCallId: string | null): Promise<TextOutcome> {
  const options = request.options ?? {}
  const meta = (route: string): CallMeta => ({
    step: request.step,
    recordingId: request.recordingId ?? null,
    route,
    parentCallId
  })

  if (profile.kind === 'router') {
    if (profile.mode === 'chat') {
      return settle(
        await deps.track(meta(`router:${profile.task}:chat`), () => deps.router.chat(profile.task, request.messages, options), emptyAnswer)
      )
    }
    const brain = await deps.router.resolve(profile.task, 'generate')
    if (!brain) return unavailable()
    if (!eligibleToGenerate(options.shouldGenerate)) return ineligible()
    return settle(await deps.track(meta(`router:${profile.task}:generate`), () => brain.generate(request.messages, options), emptyAnswer))
  }

  if (!(await deps.router.canServe(profile.harness, 'chat'))) return unavailable()
  const brain = deps.registry.get(profile.harness)
  if (!brain) return unavailable()
  if (!eligibleToGenerate(options.shouldGenerate)) return ineligible()
  return settle(await deps.track(meta(`direct:${profile.id}`), () => brain.chat(request.messages, withProfile(options, profile)), emptyAnswer))
}

export function createTextRunner(deps: RunnerDeps): (request: TextRequest) => Promise<TextOutcome> {
  return async function runText(request) {
    const call = deps.planFor(request.step).calls[0]
    const first = await runOne(deps, call.profile, request, null)
    if (first.ok || !call.onFail) return first
    if (first.reason === 'ineligible' || request.options?.signal?.aborted) return first
    return runOne(deps, call.onFail, request, first.callId)
  }
}

/** The runner over the real router, registry and plans. Built per call so a test that mocks `../brains` is honoured. */
export function runText(request: TextRequest): Promise<TextOutcome> {
  return createTextRunner({
    router: getBrainRouter(),
    registry: { get: (id) => getBrainRegistry().get(id) },
    planFor: resolvePlan,
    track: trackCall
  })(request)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/runner.test.ts`
Expected: PASS, 22 tests. If the "checks the gate again before the fallback" test returns `reason: 'empty'` instead of `'ineligible'`, the second `runOne` must have returned before the gate: the fallback's `canServe` and registry lookup come first, then the gate, so the outcome is `ineligible`; fix the code, not the test.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors). `BrainRegistry` and `BrainRouter` are exported as values from `../brains`; used here as types only. Then:

```bash
git add apps/electron/electron/main/services/pipeline
git commit -m "Pipeline: a text runner with today's routing as the default, named harnesses and one fallback"
```

---
### Task 5: The chat family goes through the runner

The seven call sites that use `chat-llm` (the assistant chat, the meeting summary, the action-item search, self-identification, the speaker roster, the meeting pick and the transcript reformat) all pass through `ChatLLMService.generate`. Changing that one method moves all of them, and each site names its step.

**Files:**
- Modify: `apps/electron/electron/main/services/chat-llm.ts`
- Modify: `apps/electron/electron/main/services/rag.ts` (three calls), `self-identification.ts`, `speaker-inference.ts`, `meeting-disambiguation.ts`, `transcript-upgrade.ts`
- Create: `apps/electron/electron/main/services/__tests__/chat-llm-steps.test.ts`
- Modify: `__tests__/meeting-disambiguation.test.ts`, `__tests__/speaker-inference.test.ts`, `__tests__/transcript-upgrade.test.ts`, `__tests__/rag-provenance-binding.test.ts` (one test each)

**Interfaces:**
- Consumes: `runText`, `TextOutcome` (Task 4); `TextStepId` (Task 2).
- Produces: `ChatGenerateOptions` gains `step?: TextStepId` (default `'chat'`) and `recordingId?: string | null`; `generateText(prompt, systemPrompt, options: { shouldGenerate?: () => boolean; step?: TextStepId; recordingId?: string | null })`. Return values are unchanged: the text, or null when nobody answered; an error the runner reports as `'error'` is thrown as it was.

- [ ] **Step 1: Write the failing tests**

Create `apps/electron/electron/main/services/__tests__/chat-llm-steps.test.ts`:

```ts
/**
 * chat-llm hands every call to the runner with the step the caller named, and gives the callers back what
 * they always got: the text, null when nobody answered, the original error when the routing itself failed.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config', () => ({ getConfig: () => ({ transcription: { geminiApiKey: '' } }) }))
vi.mock('../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

const runText = vi.hoisted(() => vi.fn())
vi.mock('../pipeline/runner', () => ({ runText }))

import { getChatLLMService, resetChatLLMService } from '../chat-llm'

const MESSAGES = [{ role: 'user' as const, content: 'hi' }]

describe('ChatLLMService through the runner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatLLMService()
    runText.mockResolvedValue({ ok: true, text: 'answer', provider: 'gemini-api', callId: 'c1' })
  })

  it('sends the step, the recording and exactly the options the router always got', async () => {
    const signal = new AbortController().signal
    const shouldGenerate = () => true
    const out = await getChatLLMService().generate(MESSAGES, {
      step: 'self-id',
      recordingId: 'rec-1',
      systemPrompt: 'sys',
      temperature: 0,
      maxTokens: 1024,
      signal,
      shouldGenerate
    })
    expect(out).toBe('answer')
    expect(runText).toHaveBeenCalledWith({
      step: 'self-id',
      messages: MESSAGES,
      recordingId: 'rec-1',
      options: { systemPrompt: 'sys', temperature: 0, maxTokens: 1024, signal, shouldGenerate }
    })
  })

  it('is the assistant chat step, with no recording, when the caller names neither', async () => {
    await getChatLLMService().generate(MESSAGES)
    expect(runText).toHaveBeenCalledWith(expect.objectContaining({ step: 'chat', recordingId: null }))
  })

  it('returns null when nobody answered, whatever the reason', async () => {
    for (const reason of ['empty', 'unavailable', 'ineligible'] as const) {
      runText.mockResolvedValue({ ok: false, reason, callId: null })
      expect(await getChatLLMService().generate(MESSAGES)).toBeNull()
    }
  })

  it('throws the original error when the runner reports one', async () => {
    const boom = new Error('router bug')
    runText.mockResolvedValue({ ok: false, reason: 'error', error: boom, callId: 'c1' })
    await expect(getChatLLMService().generate(MESSAGES)).rejects.toBe(boom)
  })

  it('generateText sends one user message and passes the step, the recording and the gate', async () => {
    const shouldGenerate = () => true
    await getChatLLMService().generateText('the prompt', 'the system', { step: 'meeting-pick', recordingId: 'rec-2', shouldGenerate })
    expect(runText).toHaveBeenCalledWith({
      step: 'meeting-pick',
      messages: [{ role: 'user', content: 'the prompt' }],
      recordingId: 'rec-2',
      options: { systemPrompt: 'the system', shouldGenerate }
    })
  })
})
```

In `__tests__/meeting-disambiguation.test.ts`, inside `describe('disambiguateOverlappingCandidates', ...)` add:

```ts
  it('names the meeting-pick step and the recording when it asks the model', async () => {
    generateText.mockResolvedValue('2')
    await disambiguateOverlappingCandidates('rec-1', CONTEXT, CANDIDATES)
    expect(generateText).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ step: 'meeting-pick', recordingId: 'rec-1' })
    )
  })
```

In `__tests__/speaker-inference.test.ts`, inside `describe('runSpeakerInference', ...)` add:

```ts
  it('names the speaker-roster step and the recording when it asks the model', async () => {
    generateText.mockResolvedValue('[]')
    await runSpeakerInference('rec-1')
    expect(generateText).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ step: 'speaker-roster', recordingId: 'rec-1' })
    )
  })
```

In `__tests__/transcript-upgrade.test.ts`, inside `describe('reformatOne — text-only reformat write + idempotency', ...)` add:

```ts
  it('names the reformat step and the recording when it asks the model', async () => {
    mockGenerate.mockResolvedValue('[{"speaker":"Speaker 1","text":"hola qué tal"}]')
    await reformatOne('t1')
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ step: 'reformat', recordingId: expect.any(String) })
    )
  })
```

In `__tests__/rag-provenance-binding.test.ts`, inside `describe('ADV19-2 — post-await recheck of all prompt components', ...)` add:

```ts
  it('names the chat step when it asks the model', async () => {
    searchMock.mockResolvedValueOnce([vectorDoc('recA', 'mA', 'ALPHA_TEXT')])
    await getRAGService().chat('conv1', 'question')
    expect(generateMock).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ step: 'chat' }))
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `lowrun npx vitest run electron/main/services/__tests__/chat-llm-steps.test.ts electron/main/services/__tests__/meeting-disambiguation.test.ts electron/main/services/__tests__/speaker-inference.test.ts electron/main/services/__tests__/transcript-upgrade.test.ts electron/main/services/__tests__/rag-provenance-binding.test.ts`
Expected: FAIL: the runner is never called from chat-llm, and the four call-site tests see no `step` in the options.

- [ ] **Step 3: Move `chat-llm` onto the runner and name the step at each site**

In `chat-llm.ts`: remove `import { getBrainRouter } from './brains'`, add `import { runText } from './pipeline/runner'` and `import type { TextStepId } from './pipeline/steps'`, and add to `ChatGenerateOptions`:

```ts
  /** Which step this call belongs to, for the call ledger and for the owner's plan. A caller that names none is the assistant chat. */
  step?: TextStepId
  /** The recording the text comes from, when there is one. */
  recordingId?: string | null
```

Replace the body of `generate` (keep its doc comment, and update the sentence about routing to: "The step's plan decides where the call goes; with no configuration that is the BrainRouter's chat route exactly as before: Gemini first, Ollama as fallback, an explicit default honoured."):

```ts
  async generate(messages: OllamaChatMessage[], options: ChatGenerateOptions = {}): Promise<string | null> {
    const outcome = await runText({
      step: options.step ?? 'chat',
      messages,
      recordingId: options.recordingId ?? null,
      options: {
        systemPrompt: options.systemPrompt,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        signal: options.signal,
        shouldGenerate: options.shouldGenerate
      }
    })
    if (outcome.ok) return outcome.text
    // The routing itself failed (not "nobody answered"): the error reaches the caller as it did when the router threw.
    if (outcome.reason === 'error') throw outcome.error
    return null
  }
```

Replace `generateText` with:

```ts
  /** Convenience: single-prompt generation (mirrors OllamaService.generate). */
  async generateText(
    prompt: string,
    systemPrompt?: string,
    options: { shouldGenerate?: () => boolean; step?: TextStepId; recordingId?: string | null } = {}
  ): Promise<string | null> {
    return this.generate([{ role: 'user', content: prompt }], {
      systemPrompt,
      shouldGenerate: options.shouldGenerate,
      step: options.step,
      recordingId: options.recordingId
    })
  }
```

The call sites (each is a one-line change in the options object; open the file and apply it where the call is):

- `rag.ts`, the assistant answer (near line 1257): in `getChatLLMService().generate(messages, { ... })` add `step: 'chat',` as the first key.
- `rag.ts`, `summarizeMeeting` (the last statement of the method, near line 1367): `return getChatLLMService().generateText(prompt, undefined, { shouldGenerate })` becomes `return getChatLLMService().generateText(prompt, undefined, { step: 'rag-summarize', shouldGenerate })`. The next method is `findActionItems`.
- `rag.ts`, `findActionItems` (near line 1411, the statement before the `removeLastMessages` doc comment): the same line becomes `{ step: 'rag-action-items', shouldGenerate }`.
- `self-identification.ts`, `defaultLLM` (near line 480): add `step: 'self-id',` before `systemPrompt,` in the options. This site has no recording at hand; the row carries none.
- `speaker-inference.ts` (near line 393): the options `{ shouldGenerate: () => isRecordingEligible(recordingId) }` become `{ step: 'speaker-roster', recordingId, shouldGenerate: () => isRecordingEligible(recordingId) }`.
- `meeting-disambiguation.ts` (near line 84): the options become `{ step: 'meeting-pick', recordingId, shouldGenerate: () => isRecordingEligible(recordingId) }`.
- `transcript-upgrade.ts` (near line 427): add `step: 'reformat',` and `recordingId,` before `systemPrompt: REFORMAT_SYSTEM_PROMPT,`.

- [ ] **Step 4: Run the tests, the chat family tests and the brains tests**

Run: `lowrun npx vitest run electron/main/services/__tests__/chat-llm electron/main/services/__tests__/meeting-disambiguation.test.ts electron/main/services/__tests__/speaker-inference.test.ts electron/main/services/__tests__/transcript-upgrade.test.ts electron/main/services/__tests__/self-identification electron/main/services/__tests__/rag- electron/main/services/brains electron/main/services/pipeline`
Expected: PASS. `chat-llm.test.ts` goes through the real router, Ollama and Gemini mocks, so it proves the chat route answers as before; `chat-llm-steps.test.ts` proves the step reaches the runner.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/chat-llm.ts apps/electron/electron/main/services/rag.ts apps/electron/electron/main/services/self-identification.ts apps/electron/electron/main/services/speaker-inference.ts apps/electron/electron/main/services/meeting-disambiguation.ts apps/electron/electron/main/services/transcript-upgrade.ts apps/electron/electron/main/services/__tests__
git commit -m "Pipeline: the chat family asks the runner, each call site naming its step"
```

---

### Task 6: Notes

**Files:**
- Modify: `apps/electron/electron/main/services/note-intelligence.ts`
- Create: `apps/electron/electron/main/services/__tests__/note-analysis.test.ts`

**Interfaces:**
- Consumes: `runText` (Task 4).
- Produces: no new names; `analyzeNote` behaves as before.

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/main/services/__tests__/note-analysis.test.ts`:

```ts
/**
 * analyzeNote asks the notes step through the runner, with the options it always used, and turns every
 * kind of outcome into what the editor shows: an analysis, a failed mark with a reason, or the note as is.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/tmp'), getName: vi.fn().mockReturnValue('test') } }))
vi.mock('../vector-store', () => ({ getVectorStore: vi.fn() }))
vi.mock('../database', () => ({ getDatabase: vi.fn(), queryAll: vi.fn(), queryOne: vi.fn() }))

const runText = vi.hoisted(() => vi.fn())
vi.mock('../pipeline/runner', () => ({ runText }))

const notes = vi.hoisted(() => ({
  getNote: vi.fn(),
  needsAnalysis: vi.fn(() => true),
  markAnalysisPending: vi.fn(),
  markAnalysisFailed: vi.fn(),
  applyAnalysis: vi.fn(),
  contentFingerprint: vi.fn(() => 'hash-1')
}))
vi.mock('../notes', () => notes)

import { analyzeNote } from '../note-intelligence'

const GOOD = JSON.stringify({ title: 'Presupuesto', summary: 'Dos líneas.', category: 'decision', tags: ['finanzas'] })

describe('analyzeNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notes.getNote.mockReturnValue({ id: 'n1', content: 'El presupuesto de septiembre' })
    notes.needsAnalysis.mockReturnValue(true)
    notes.applyAnalysis.mockReturnValue({ id: 'n1', analyzed: true })
    runText.mockResolvedValue({ ok: true, text: GOOD, provider: 'gemini-api', callId: 'c1' })
  })

  it('asks the notes step with the note text and the options it always used, and applies the analysis', async () => {
    const result = await analyzeNote('n1')
    expect(runText).toHaveBeenCalledWith({
      step: 'notes',
      messages: [{ role: 'user', content: 'El presupuesto de septiembre' }],
      options: { systemPrompt: expect.stringContaining('You organise short hand-written notes'), temperature: 0.2, maxTokens: 500 }
    })
    expect(notes.applyAnalysis).toHaveBeenCalledWith('n1', expect.objectContaining({ category: 'decision' }), 'hash-1')
    expect(result).toEqual({ id: 'n1', analyzed: true })
  })

  it('marks the analysis failed, with the usual reason, when nobody answered', async () => {
    runText.mockResolvedValue({ ok: false, reason: 'empty', callId: 'c1' })
    await analyzeNote('n1')
    expect(notes.markAnalysisFailed).toHaveBeenCalledWith('n1', 'The model did not return a result this note could use.')
    expect(notes.applyAnalysis).not.toHaveBeenCalled()
  })

  it('marks the analysis failed with the error message when the routing failed', async () => {
    runText.mockResolvedValue({ ok: false, reason: 'error', error: new Error('router bug'), callId: 'c1' })
    await analyzeNote('n1')
    expect(notes.markAnalysisFailed).toHaveBeenCalledWith('n1', 'router bug')
  })

  it('does not ask for an empty note, or one that needs no analysis', async () => {
    notes.getNote.mockReturnValue({ id: 'n1', content: '   ' })
    await analyzeNote('n1')
    notes.getNote.mockReturnValue({ id: 'n1', content: 'text' })
    notes.needsAnalysis.mockReturnValue(false)
    await analyzeNote('n1')
    expect(runText).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/__tests__/note-analysis.test.ts`
Expected: FAIL: `analyzeNote` still calls the router, so `runText` is never called.

- [ ] **Step 3: Change `analyzeNote`**

In `note-intelligence.ts` replace `import { getBrainRouter } from './brains'` with `import { runText } from './pipeline/runner'`, and replace

```ts
    const answer = await getBrainRouter().chat(
      'suggestions',
      [{ role: 'user', content: note.content.slice(0, MAX_ANALYSIS_CHARS) }],
      { systemPrompt: SYSTEM_PROMPT, temperature: 0.2, maxTokens: 500 }
    )
    const analysis = parseAnalysis(answer)
```

with

```ts
    const outcome = await runText({
      step: 'notes',
      messages: [{ role: 'user', content: note.content.slice(0, MAX_ANALYSIS_CHARS) }],
      options: { systemPrompt: SYSTEM_PROMPT, temperature: 0.2, maxTokens: 500 }
    })
    // A failure of the routing itself reaches the catch below, as it did when the router threw.
    if (!outcome.ok && outcome.reason === 'error') throw outcome.error
    const analysis = parseAnalysis(outcome.ok ? outcome.text : null)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/services/__tests__/note-analysis.test.ts electron/main/services/__tests__/note-intelligence.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/note-intelligence.ts apps/electron/electron/main/services/__tests__/note-analysis.test.ts
git commit -m "Pipeline: note analysis asks the notes step through the runner"
```

---

### Task 7: Outputs

**Files:**
- Modify: `apps/electron/electron/main/services/output-generator.ts`
- Modify: `apps/electron/electron/main/services/__tests__/output-generator.test.ts` (one new `describe`)

**Interfaces:**
- Consumes: `runText` (Task 4).
- Produces: no new names; `OutputGeneratorService.generate` throws the same errors as before.

The outputs route resolves one brain (`taskRouting.outputs`, then the default brain, then Gemini, then Ollama) and calls its `generate` once, with no walk down a chain, and lets a provider error propagate. That is the router profile in `generate` mode.

- [ ] **Step 1: Write the failing tests**

In `__tests__/output-generator.test.ts`, add a `describe` at the end of the top-level `describe('OutputGeneratorService', ...)` block (before its closing `})`), reusing the file's mocks (`mockOllamaIsAvailable`, `mockOllamaGenerate`, `db`):

```ts
  describe('what the caller sees when the runner cannot produce a document', () => {
    function stubCapture(): void {
      vi.mocked(db.queryOne).mockReturnValue({
        id: 'kc-1',
        title: 'Knowledge Capture 1',
        source_recording_id: 'rec-1',
        captured_at: new Date().toISOString()
      })
      vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({
        id: 'trans-1',
        recording_id: 'rec-1',
        full_text: 'Full transcript text',
        language: 'en',
        created_at: new Date().toISOString()
      } as any)
    }

    it('says no provider is available when none can serve', async () => {
      mockOllamaIsAvailable.mockResolvedValue(false) // and the default config has no Gemini key
      stubCapture()
      await expect(
        getOutputGeneratorService().generate({ templateId: 'meeting_minutes', knowledgeCaptureId: 'kc-1' })
      ).rejects.toThrow(/No output provider available/)
    })

    it('asks to try again when the provider answers nothing', async () => {
      mockOllamaGenerate.mockResolvedValue(null as unknown as string)
      stubCapture()
      await expect(
        getOutputGeneratorService().generate({ templateId: 'meeting_minutes', knowledgeCaptureId: 'kc-1' })
      ).rejects.toThrow(/Failed to generate output/)
    })
  })
```

- [ ] **Step 2: Run the tests to verify the new ones pass before the change and the suite is the baseline**

Run: `lowrun npx vitest run electron/main/services/__tests__/output-generator.test.ts`
Expected: PASS, including the two new tests. They describe behaviour that exists today; they are the safety net for the change in step 3, and the existing tests (the Gemini error that must propagate without a fallback to Ollama, the fail-closed refusal, the eligibility flip during resolution) are the rest of it. If either new test fails before any change, fix the test's setup, not the code.

- [ ] **Step 3: Move the call onto the runner**

In `output-generator.ts`: replace the import of `getBrainRouter` with `import { runText } from './pipeline/runner'` (delete the `getBrainRouter` import if nothing else in the file uses it; the only use is the `resolve` call below). Replace the block that starts at the comment `// Prefer the configured cloud brain (Gemini, same credentials as` and ends with the `if (!content) { throw new Error('Failed to generate output. Please try again.') }` statement (from the `resolve` call to the check on `content`) with:

```ts
    // The step's plan decides which provider writes the document. With no configuration that is the
    // BrainRouter's outputs route exactly as before: the routed brain, else the default brain, else Gemini,
    // else Ollama; one brain, one call, and a provider error reaches the caller.
    //
    // ADV41-4 (round-43): resolving the provider is an await (auth, availability); an owner deletion,
    // mark-personal or value-exclusion can commit during it. The prompt was assembled from eligibility
    // snapshotted before, so the runner calls this gate immediately before the provider call, after it has
    // resolved which provider that is. If ANY source is now ineligible, or eligibility cannot be established
    // (fail closed), it refuses rather than send an excluded transcript to the brain: the prompt already
    // embeds every source's text, so partial dropping is not possible.
    const outcome = await runText({
      step: 'outputs',
      messages: [{ role: 'user', content: prompt }],
      options: {
        systemPrompt,
        shouldGenerate: () => {
          const recheck = filterEligibleRecordingIds(sourceRecordingIds)
          return !(recheck.failClosed || sourceRecordingIds.some((id) => !recheck.eligible.has(id)))
        }
      }
    })
    if (!outcome.ok) {
      if (outcome.reason === 'unavailable') {
        throw new Error('No output provider available. Configure a Gemini API key in Settings or start Ollama.')
      }
      if (outcome.reason === 'ineligible') {
        throw new Error(
          'Recording eligibility changed during provider resolution — output generation refused (fail closed)'
        )
      }
      if (outcome.reason === 'error') throw outcome.error
      throw new Error('Failed to generate output. Please try again.')
    }
    const content = outcome.text
```

Keep the lines after it (`return { content, templateId, generatedAt }`) as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/services/__tests__/output-generator.test.ts`
Expected: PASS, every test including the two new ones and the eligibility ones.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/output-generator.ts apps/electron/electron/main/services/__tests__/output-generator.test.ts
git commit -m "Pipeline: output generation asks the outputs step through the runner"
```

---

### Task 8: The handover run is recorded

**Files:**
- Modify: `apps/electron/electron/main/services/handover-service.ts`
- Modify: `apps/electron/electron/main/services/__tests__/handover-service.test.ts` (one test, one import)

**Interfaces:**
- Consumes: `withCallRecord` (Task 3); `setCallSink`, `CallRecord` (Task 1).
- Produces: no new names.

The handover keeps resolving its own brain (an explicit brain from the UI, checked to be agentic, logged by label before the run). Only the call is recorded.

- [ ] **Step 1: Write the failing test**

In `__tests__/handover-service.test.ts` add `import { setCallSink, type CallRecord } from '../pipeline/call-store'` with the other imports, and inside the `describe` that contains `mockBrain` and `'runs the agent, writes RUN.log, ...'` add:

```ts
  it('leaves one ledger row per agent run, completed or failed', async () => {
    const rows: CallRecord[] = []
    setCallSink((_id, record) => {
      rows.push(record)
    })
    try {
      await runHandoverAgent({
        bundleId: 'bundle-1',
        resolveBrain: async () => mockBrain('Did the work.') as any,
        emit: () => {},
        lookupBundle: lookup,
      })
      await runHandoverAgent({
        bundleId: 'bundle-1',
        resolveBrain: async () => mockBrain(null) as any,
        emit: () => {},
        lookupBundle: lookup,
      })
    } finally {
      setCallSink(null)
    }
    expect(rows.map((r) => [r.step, r.route, r.status])).toEqual([
      ['handover', 'agentic', 'completed'],
      ['handover', 'agentic', 'failed'],
    ])
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/__tests__/handover-service.test.ts`
Expected: FAIL: `rows` is empty.

- [ ] **Step 3: Record the call**

In `handover-service.ts` add `import { withCallRecord } from './pipeline/track-call'` and replace

```ts
      finalResponse = await brain.generate([{ role: 'user', content: prompt }], {
        signal: params.signal,
        cwd: targetDir,
        agentic: true,
      })
```

with

```ts
      finalResponse = await withCallRecord(
        { step: 'handover', route: 'agentic' },
        () =>
          brain.generate([{ role: 'user', content: prompt }], {
            signal: params.signal,
            cwd: targetDir,
            agentic: true,
          }),
        (value) => (value == null || value === '' ? 'empty answer' : null)
      )
```

The `try`/`catch` around it stays: a throw still ends in `finalResponse = null` and the contract-violation log.

- [ ] **Step 4: Run the test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/__tests__/handover-service.test.ts`
Expected: PASS, every test of the file.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/handover-service.ts apps/electron/electron/main/services/__tests__/handover-service.test.ts
git commit -m "Pipeline: the handover agent run leaves a ledger row"
```

---

### Task 9: The three Jev calls are recorded

**Files:**
- Create: `apps/electron/electron/main/services/pipeline/jev-jobs.ts`
- Create: `apps/electron/electron/main/services/pipeline/__tests__/jev-jobs.test.ts`
- Modify: `apps/electron/electron/main/services/pipeline/jev-harness.ts`, `pipeline/__tests__/jev-harness.test.ts`
- Modify: `apps/electron/electron/main/services/value-classification.ts`, `jev-meeting-match.ts`, `speaker-inference.ts`
- Modify: `__tests__/value-classification.test.ts`, `__tests__/jev-meeting-match.test.ts`, `__tests__/speaker-inference.test.ts` (one test and one import each)

**Interfaces:**
- Consumes: `createJevHarness` (phase 1), `withCallRecord` (Task 3), `jevKeyFor`, `JevJob` from `./jev-settings`.
- Produces:
  - `jevHarnessFor(job: JevJob): JevHarness` moves from `pipeline/jev-harness.ts` to `pipeline/jev-jobs.ts`. Nothing calls it yet. `jev-harness.ts` then imports no configuration, so the three Jev sites can use it without pulling `config.ts` into their tests.
  - `evaluateWithJev`'s `input` gains `recordingId?: string | null`.

- [ ] **Step 1: Write the failing tests**

In `pipeline/__tests__/jev-harness.test.ts`, inside `describe('createJevHarness', ...)`, add:

```ts
  it('still reports the call and its time when the response states no usage', async () => {
    const askImpl = vi.fn(async () => ({ model: 'jev-latest', answers: {} }) as unknown as JevResponse)
    const harness = createJevHarness({ getKey: () => 'k', askImpl })
    const collector = createHarnessUsageCollector()
    await collector.run(() => harness.ask('state', {}))
    expect(collector.total()!.byModel['jev:jev-latest'].calls).toBe(1)
  })
```

Create `pipeline/__tests__/jev-jobs.test.ts`:

```ts
/**
 * The Jev harness of one job is configured only when Jev and that job's switch are on.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../jev-settings', () => ({
  jevKeyFor: (job: string) => (job === 'value' ? 'the-key' : null)
}))

import { jevHarnessFor } from '../jev-jobs'

describe('jevHarnessFor', () => {
  it('is configured for a job whose switch is on and not for one whose switch is off', () => {
    expect(jevHarnessFor('value').isConfigured()).toBe(true)
    expect(jevHarnessFor('meetingMatch').isConfigured()).toBe(false)
  })
})
```

In `__tests__/value-classification.test.ts` add `import { setCallSink, type CallRecord } from '../pipeline/call-store'` with the other imports, and right after the test `'asks Jev, not the LLM, when a Jev key is set, and persists its verdict'` add:

```ts
  it('leaves one ledger row for the Jev evaluation, linked to the recording', async () => {
    seedRecording('rec-j1c')
    seedTranscript('rec-j1c', { fullText: 'Hola mamá, ¿qué cocinamos hoy? Pasta con salsa.' })
    seedCapture('cap-j1c', 'rec-j1c', { summary: 'Family chat about dinner.' })
    mockAskJev.mockResolvedValue(jevReply(1, 0.9, { personal_family: 0.93 }, { kind: 'personal_call', context: 'personal' }))
    const rows: CallRecord[] = []
    setCallSink((_id, record) => {
      rows.push(record)
    })
    try {
      await classifyCaptureValue('cap-j1c')
    } finally {
      setCallSink(null)
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      step: 'evaluate',
      route: 'jev',
      provider: 'jev',
      model: 'jev-1.13.0',
      recordingId: 'rec-j1c',
      status: 'completed'
    })
    expect(rows[0].usage).toMatchObject({ tokens: { input: 900, output: 40 } })
  })
```

In `__tests__/jev-meeting-match.test.ts` add the same import and, inside `describe('matchMeetingWithJev', ...)`, add:

```ts
  it('leaves one ledger row for the call, linked to the recording, and none when the stored answer is reused', async () => {
    const rows: CallRecord[] = []
    setCallSink((_id, record) => {
      rows.push(record)
    })
    try {
      let stored: MeetingMatch | null = null
      const ask = vi.fn(async () => reply({ m1: 0.02, m2: 0.93, none: 0.05 }))
      const deps = { apiKey: 'k', load: () => stored, save: (_id: string, m: MeetingMatch) => (stored = m), ask }
      await matchMeetingWithJev('rec-1', context, [lunch, daily], deps)
      await matchMeetingWithJev('rec-1', context, [lunch, daily], deps)
    } finally {
      setCallSink(null)
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ step: 'meeting-match', route: 'jev', provider: 'jev', model: 'jev-1.13.0', recordingId: 'rec-1', status: 'completed' })
    expect(rows[0].usage).toMatchObject({ tokens: { input: 1800, output: 20 } })
  })
```

In `__tests__/speaker-inference.test.ts` add the same import and, inside `describe('runSpeakerInference', ...)`, add:

```ts
  it('leaves one ledger row for the Jev call, linked to the recording', async () => {
    const rows: CallRecord[] = []
    setCallSink((_id, record) => {
      rows.push(record)
    })
    try {
      const askJev = vi.fn(async () => ({
        model: 'jev',
        answers: { s1: { type: 'choice' as const, choice: 'p1', probabilities: { p1: 0.95, none: 0.05 }, confidence: 1 } },
        usage: { input_tokens: 10, output_tokens: 1 }
      }))
      await runSpeakerInference('rec-1', { jevKey: () => 'key', askJev })
    } finally {
      setCallSink(null)
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ step: 'speaker-names', route: 'jev', provider: 'jev', recordingId: 'rec-1', status: 'completed' })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/jev-harness.test.ts electron/main/services/pipeline/__tests__/jev-jobs.test.ts electron/main/services/__tests__/value-classification.test.ts electron/main/services/__tests__/jev-meeting-match.test.ts electron/main/services/__tests__/speaker-inference.test.ts`
Expected: FAIL: the harness throws on a response without `usage`, `jev-jobs` does not exist, and the three sites leave no rows.

- [ ] **Step 3: Harden the harness, split the job helper, record the three sites**

In `pipeline/jev-harness.ts`: delete the `jevKeyFor, type JevJob` import from `../jev-settings` and delete the `jevHarnessFor` function with its doc comment. Change the usage report so a response without usage still counts:

```ts
      const usage = (response as { usage?: JevResponse['usage'] }).usage
      recordHarnessUsage({
        harness: 'jev',
        model: response.model || JEV_MODEL,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        durationMs: Date.now() - startedAt
      })
```

Create `pipeline/jev-jobs.ts`:

```ts
/**
 * The Jev harness of one job: configured only when Jev and that job's switch are on (Settings > Decisions).
 * Kept apart from jev-harness.ts so the harness, and every file that records a Jev call, imports no
 * configuration.
 */
import { jevKeyFor, type JevJob } from '../jev-settings'
import { createJevHarness, type JevHarness } from './jev-harness'

export function jevHarnessFor(job: JevJob): JevHarness {
  return createJevHarness({ getKey: () => jevKeyFor(job) })
}
```

In `value-classification.ts` add `import { createJevHarness } from './pipeline/jev-harness'` and `import { withCallRecord } from './pipeline/track-call'`; add `recordingId?: string | null` to the `input` type of `evaluateWithJev`; replace

```ts
  const response = await askJev(apiKey, state, buildEvaluationQuestions(), { fetchImpl })
```

with

```ts
  const harness = createJevHarness({ getKey: () => apiKey })
  const response = await withCallRecord({ step: 'evaluate', route: 'jev', recordingId: input.recordingId ?? null }, () =>
    harness.ask(state, buildEvaluationQuestions(), { fetchImpl })
  )
```

and in `classifyCaptureValue`, in the `evaluateWithJev(jevKey as string, { ... })` call, add `recordingId: row.recording_id,` to the input object. If `askJev` has no other use in the file, remove it from the `./jev-client` import.

In `jev-meeting-match.ts` add the same two imports and replace

```ts
  const res = await (deps.ask ?? askJev)(deps.apiKey, state, questions)
```

with

```ts
  const harness = createJevHarness({ getKey: () => deps.apiKey, askImpl: deps.ask ?? askJev })
  const res = await withCallRecord({ step: 'meeting-match', route: 'jev', recordingId }, () => harness.ask(state, questions))
```

In `speaker-inference.ts` add the same two imports and replace

```ts
    const res = await (opts.askJev ?? askJev)(jevKey, request.state, request.questions)
```

with

```ts
    const harness = createJevHarness({ getKey: () => jevKey, askImpl: opts.askJev ?? askJev })
    const res = await withCallRecord({ step: 'speaker-names', route: 'jev', recordingId }, () =>
      harness.ask(request.state, request.questions)
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/services/pipeline electron/main/services/__tests__/value-classification electron/main/services/__tests__/jev-meeting-match.test.ts electron/main/services/__tests__/speaker-inference.test.ts electron/main/services/__tests__/transcription-value-classification.test.ts`
Expected: PASS. The existing tests count Jev calls and read their arguments by position; the harness passes the same key, state and questions through.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/pipeline apps/electron/electron/main/services/value-classification.ts apps/electron/electron/main/services/jev-meeting-match.ts apps/electron/electron/main/services/speaker-inference.ts apps/electron/electron/main/services/__tests__
git commit -m "Pipeline: the three Jev calls report their usage and leave a ledger row"
```

---
### Task 10: Verification, documents and delivery

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-pipeline-design.md` (status line, section 9 step 8, the phases table)
- Modify: `docs/superpowers/specs/2026-09-30-pipeline-design-inventory.md` (the processing runs section)

- [ ] **Step 1: Update the design documents**

In the design: change the status line to name phases 0, 1 and 2a and their pull requests. In section 9, step 8, replace "one `processing_runs` row per call, `stage` = the step or task id, `provider` = harness, `model`, `usage_json`, `estimated_cost_*`, `parent_run_ids` = the previous pass" with "one `pipeline_calls` row per call (`step`, `route`, `provider` = harness, `model`, `usage_json`, `estimated_cost_*`, `parent_call_id` = the attempt that failed before it); `processing_runs` keeps the per-recording stages the reader shows". In the phases table replace row 2 with two rows:

```
| 2a | Text runner with `single` and `fallback`, the `pipeline_calls` ledger, default plans that keep today's routing; the nine text call sites that go through the router and the three Jev call sites on it. Built (PR #N). | a ledger row per call with time, tokens and cost; no change in results |
| 2b | The six text call sites that call the Gemini SDK directly (analysis bundle, action detection, timeline, LLM value rating, graph ingest, image description) on the runner | usage and cost for all text calls |
```

with `N` the number of the pull request that carries this plan. In the inventory, in the "Processing runs" section, add: "As of phase 2a, the calls of rows 11, 12, 13, 15, 16, 21, 22, 23, 24, 25 and 26 are recorded in `pipeline_calls` (`S/pipeline/call-store.ts`), with or without a recording. Rows 8, 9, 10, 14, 17, 18 and 27 follow in phase 2b."

- [ ] **Step 2: Run everything, one command at a time**

Run each with `lowrun`, from `apps/electron`: `npm run typecheck`, `npx eslint electron`, `npx vitest run` (the whole suite; it takes about two minutes and must be the only heavy job running).
Expected: no type errors, no lint output, every test passing (532 files and 6,874 tests at the end of phase 1, plus the new ones: about 8 files and 65 tests).

- [ ] **Step 3: Check the wiring by hand against a real database**

The ledger is installed at boot and the tests use a sink, so one check covers what they cannot: that the main process installs it and that a row really lands. Run, from `apps/electron`: `lowrun npx vitest run electron/main/services/pipeline/__tests__/call-store.test.ts` (real better-sqlite3, the v64 migration) and read `index.ts` to confirm it calls `installCallStore({ run, queryAll })` on the line after `Database initialized`. The diff shows both lines; there is nothing else to start.

- [ ] **Step 4: Secret gate, then push**

Run the secret gate from the Global Constraints as its own command and expect no output. Then check the account (`gh auth status --active` must show `sgeraldes`; if it shows the other account run `gh auth switch --user sgeraldes` as its own command) and push the branch.

- [ ] **Step 5: Adversarial review by a separate agent**

From the repository root, with the prompt in a file so it never passes through the shell as an argument list:

```bash
timeout 900 "/c/Users/Sebastian/AppData/Local/Kiro-Cli/run/chat-cli-2.24.1.exe" chat --no-interactive --trust-tools=fs_read,execute_bash "$(cat review-prompt.txt)" > kiro-out.txt
```

Write `review-prompt.txt` in the session scratch folder with this text, replacing `<BRANCH>` with the branch and `<FINDINGS FILE>` with an absolute path in the same folder (both forms of the path, POSIX and Windows, as in phase 1, because the reviewer has no file-writing tool and writes the file from a shell):

```text
Review the commits of branch <BRANCH> against main (git log main..HEAD, git diff main...HEAD). Bugs only, no style. Time cap 10 minutes; write your findings file EARLY and update it as you go.

Context: pipeline phase 2a (docs/superpowers/specs/2026-09-30-pipeline-design.md, docs/superpowers/plans/2026-10-01-pipeline-phase-2a-runner.md). Check: (a) pipeline/call-store.ts and migration 64: the table, the foreign key, the fresh-install schema against the migration (same columns), that nothing but the installed sink writes, that a failing write never reaches the caller, that no row can hold a prompt or an answer; (b) pipeline/track-call.ts: usage isolation between calls that run at once, the status of an abort and of a throw, the error text cap, that a judge refusal is a failed row and still returns the value; (c) pipeline/runner.ts: the router chat route passes the same task and the same options object as the code it replaced, null and empty string are no answer and a string of spaces is an answer, the generate route resolves then gates then calls, the gate runs before every attempt including the fallback, the fallback never runs after an abort or an ineligible source, a named harness gets its profile settings over the caller's, and the registry is not touched for a router profile; (d) chat-llm.ts and the seven sites: each names the right step, the returned value and the thrown error are what the callers saw before, getLastChatFailure still works for rag.ts; (e) output-generator.ts: the three error messages and their order (no provider, eligibility changed, empty) against the code they replaced; (f) note-intelligence.ts, handover-service.ts: same; (g) the three Jev sites: the arguments reaching askJev are unchanged, a stored answer reused by the meeting match records nothing, a response without usage does not throw; (h) tests that would pass while the behaviour is broken, and any existing test that now passes only because a mock hides the new path. Do not edit files and do not run the whole suite.

Write findings to <FINDINGS FILE> with severity, file:line and the concrete scenario; write NO FINDINGS if none. Plain English. You have no file-writing tool, so write the findings file with a shell command through execute_bash; that one file is the only thing you may write.
```

Fix every finding with a test that failed first, or decide on it in writing in the pull request description.

- [ ] **Step 6: Open the pull request, wait for CI, merge, clean up**

Open the pull request against `main` with a description that lists the tasks, states "no visible change", names the ledger table and its columns, and lists the findings with what was done. When CI is green and the review is closed, squash-merge with the branch deletion, fast-forward the main checkout, remove the worktree with `git worktree remove` (plain), delete the local branch with `git branch -d`, and delete the scratch files by their literal names.

---

## What plan 2b covers

The six sites that call the Gemini SDK directly each have their own prompt, parser, retries and sink, and each needs a test that the new path produces the same request and the same stored result as the code it replaces:

| Row | Site | What the plan must settle |
|---|---|---|
| 8 | transcript analysis bundle (`transcription.ts:1631`) | two attempts (plain, then `responseMimeType`), `thinkingBudget: 0`, maxOutput 8192, the `summary` / `title` / `meeting-resolution` runs that share one call |
| 9 | action detection (`transcription.ts:1002`) | already goes through `GeminiApiBrain.generate`; the options it sets (`json`, `disableThinking`, maxTokens 8192) must survive |
| 10 | timeline (`timeline-analysis.ts:594`) | the key comes from the plain config field, not the credential store |
| 14 | LLM value rating (`value-classification.ts:681`) | `getProviderConfigFromSettings()` needs `chat.provider === 'gemini'` |
| 17, 18 | graph ingest (`knowledge-graph-service.ts:309`, `:466`) | Gemini key from the credential store plus `chat.geminiModel`; errors kept per transcript |
| 27 | image description (`artifact-types.ts:236`) | images need an input path on the brain interface (`BrainMessage` carries text only today), which is also what turns the `vision` capability on |

Plan 2b also adds a `schema` option to `GenerateOptions` for the structured tasks (turning `json-schema` on for the adapters that can enforce it) and moves the bundle's parsing onto `runContract` from phase 1. It starts when 2a is merged.

## Self-review

- Spec coverage: section 9 steps 1 (resolve, fallback), 2 (gate), 4 (execute: the resource classes are not needed until calls run in parallel, phase 5), 8 (record) and 9 (report: the ledger is the record; progress events to the Operations panel belong to phase 3) are covered for the twelve sites. Steps 3 (cache), 5 and 6 (parse and merge: phase 2b for parsing, phase 5 for merging) and 7 (candidate runs: phase 3) are outside this plan on purpose.
- Placeholders: none. Every code step shows the code, and every edit of an existing file quotes the text it replaces.
- Types: `TextStepId` (Task 2) is used by the runner (Task 4) and `chat-llm` (Task 5); `CallMeta.step` takes `StepId`, which contains `TextStepId` and the four observed steps; `TextOutcome` (Task 4) is read by Tasks 5, 6 and 7; `CallRecord` (Task 1) is what `trackCall` (Task 3) writes and what Tasks 8 and 9 read in their tests.
- Review Focus: line 1 is tested in Task 1 (sink that throws, foreign key) and Task 3 (ledger cannot be written); line 2 in Task 3; line 3 in Task 4 (fallback block); line 4 in Tasks 4, 5 and 7; line 5 in Task 4 ("does not touch the registry") and by the handover and note tests, which mock `../brains`; line 6 in Task 3 (two calls at once).

## Build notes (1-oct-2026)

What differed from this plan when it was built, and why.

- The headless brain host installs no ledger. It opens the database read-only, so a write would fail on every call, and the one `initializeDatabase` call in it is the upgrade path that closes the database at once. The plan said to wire both entry points; only `main/index.ts` is wired.
- The review of this plan by a separate agent (kiro-cli) found the one real defect: the router chat route returns null both when nobody could answer and when the caller aborted or the source stopped being eligible, so the runner recorded such a call as a failed empty answer, counted it against the step, and would have offered a fallback to a source that was gone. Fixed in the build, with a test that failed first:
  - `Judge` may return a status of its own (`JudgeVerdict`: a failure message, or `{ status: 'failed' | 'cancelled', message }`), and `trackCall` records it.
  - `judgeAnswer(options)` replaces `emptyAnswer` in the runner: a null with an aborted signal is cancelled ("aborted"), a null with a gate that now says no is cancelled ("source no longer eligible"), any other null is a failed "empty answer".
  - `settle(tracked, options)` reports a null whose gate now says no as `ineligible`, so the plan's fallback does not run.
  - The router chat route checks the gate before the call, so a source that is already ineligible leaves no row (the generate route and a named harness already did).
  Task 4's tests gained three cases (ineligible before the call, ineligible during it, aborted during it) and Task 3's one (a judge that names a status).
- The other two findings were about anchors: the two identical `generateText` lines of `rag.ts` are told apart by the method that follows each (`findActionItems`, and the doc comment of `removeLastMessages`), and `getCallsForRecording` and `getRecentCalls` throw when no database is installed, which the tests cover.

