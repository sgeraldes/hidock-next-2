import { app, safeStorage } from 'electron'
import { join } from 'path'
import { getConfig, getDataPath } from './config'
import { queryAll, queryOne } from './database'
import { filterEligibleCaptureIds, filterEligibleRecordingIds, filterEligibleProvenanceRows } from './recording-eligibility'
import { RetrievalTraceStore, type TraceCandidate, type TraceEvent, type TraceStats } from './retrieval-traces'

let store: RetrievalTraceStore | undefined
async function eligible(candidate: TraceCandidate): Promise<boolean> {
  if (candidate.channel === 'vector' && candidate.capture_id) {
    return filterEligibleProvenanceRows([candidate], c => c.recording_id, c => c.capture_id).length === 1
  }
  if (candidate.recording_ids?.length) {
    const result = filterEligibleRecordingIds(candidate.recording_ids)
    if (result.failClosed || candidate.recording_ids.some(id => !result.eligible.has(id))) return false
  }
  const recording = candidate.recording_id ?? (candidate.source_kind === 'recording' ? candidate.source_id : undefined)
  const capture = candidate.capture_id ?? (candidate.source_kind === 'capture' ? candidate.source_id : undefined)
  if (recording) {
    const result = filterEligibleRecordingIds([recording])
    if (result.failClosed || !result.eligible.has(recording)) return false
  }
  if (capture) {
    const result = filterEligibleCaptureIds([capture])
    if (result.failClosed || !result.eligible.has(capture)) return false
  }
  if (recording || capture) return true
  if (candidate.source_kind === 'actionable') {
    const row = queryOne<{ source_knowledge_id: string }>('SELECT source_knowledge_id FROM actionables WHERE id = ?', [candidate.source_id])
    return !!row?.source_knowledge_id && eligible({ ...candidate, source_kind: 'capture', source_id: row.source_knowledge_id })
  }
  if (candidate.source_kind === 'meeting') {
    if (!queryOne('SELECT id FROM meetings WHERE id = ?', [candidate.source_id])) return false
    const rows = queryAll<{ id: string }>('SELECT id FROM recordings WHERE meeting_id = ?', [candidate.source_id])
    if (!rows.length) return true
    const result = filterEligibleRecordingIds(rows.map(row => row.id))
    return !result.failClosed && result.eligible.size > 0
  }
  if (candidate.source_kind === 'graph-node') {
    const { isTraceGraphNodeEligible } = await import('./knowledge-graph-service')
    return isTraceGraphNodeEligible(candidate.source_id)
  }
  return false
}
function getStore(): RetrievalTraceStore {
  if (!store) store = new RetrievalTraceStore({ path: join(getDataPath(), 'traces', 'retrieval-traces.db'), storage: safeStorage, eligible })
  return store
}
export function recordRetrievalTrace(event: TraceEvent): void {
  try {
    const config = getConfig()
    if (config.chat.recordQueries === false) return
    const target = getStore()
    target.applySettings({ recordQueries: true, keepQueryText: config.chat.keepQueryText !== false })
    target.record({ ...event, app_version: app.getVersion() })
  } catch { /* telemetry never changes a request's outcome */ }
}
export function linkTraceAnswer(generationId: string, messageId: string): void {
  try { if (getConfig().chat.recordQueries !== false) getStore().linkAnswer(generationId, messageId) } catch { /* best effort */ }
}
export async function syncTraceSettings(): Promise<void> {
  try {
    const config = getConfig().chat
    await getStore().setSettings({ recordQueries: config.recordQueries !== false, keepQueryText: config.keepQueryText !== false })
  } catch { /* settings remain usable if telemetry storage fails */ }
}
export async function retrievalTraceStats(): Promise<TraceStats> {
  await syncTraceSettings()
  return getStore().stats()
}
export function startRetrievalTraces(): void {
  setImmediate(() => {
    void (async () => {
      await syncTraceSettings()
      await getStore().retain()
    })().catch(() => { /* optional telemetry housekeeping */ })
  })
}
export async function closeRetrievalTraces(): Promise<void> {
  const current = store
  store = undefined
  await current?.close()
}
