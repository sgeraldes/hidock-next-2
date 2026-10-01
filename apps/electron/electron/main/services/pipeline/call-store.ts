/**
 * The ledger of AI calls: one row per call a pipeline step makes, with or without a recording.
 *
 * It exists next to `processing_runs` and does not replace it: a processing run belongs to a recording
 * and names a stage the reader shows; a call belongs to a step and may have no recording (the assistant
 * chat, notes, outputs). The Pipeline page reads the median time and cost of each step from here.
 *
 * Writing is behind a replaceable sink so that code which reaches a call site in a test, or before the
 * database opens, stores nothing and needs no database. `installCallStore(db)` sets the database sink;
 * the main process calls it right after `initializeDatabase()`, handing in `run` and `queryAll`. The
 * headless brain host does not: it opens the database read-only and runs no text step. This module
 * imports nothing from `database.ts`, so a file that records a call does not pull the database (and
 * Electron) into its tests.
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
