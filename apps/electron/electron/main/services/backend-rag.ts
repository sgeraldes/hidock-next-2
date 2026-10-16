import { randomUUID } from 'crypto'
import { run, queryOne } from './database'
import { getRAGService } from './rag'
import { getVectorStore } from './vector-store'
import { isFeatureEnabled } from './feature-gate'
import { getVectorStartupState } from './vector-startup-state'
import { markVectorStartupLoading, markVectorStartupReady, markVectorStartupFailed } from './vector-startup-state'
import { resolvePlan } from './pipeline/plans'
import { packSources, revalidateStoredSources, isProvenanceExcluded, REDACTED_ANSWER } from './chat-source-provenance'

function requireAssistant(): void {
  if (!isFeatureEnabled('assistant')) throw new Error('Assistant feature is disabled')
}

export function createBackendConversation(title: string): { id: string } {
  requireAssistant()
  const id = randomUUID()
  const now = new Date().toISOString()
  run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, title, now, now])
  return { id }
}

export async function backendRagStatus(): Promise<unknown> {
  requireAssistant()
  // Report the actual configured plan without probing/spawning CLI providers.
  return { chatPlan: resolvePlan('chat'), index: getVectorStartupState() }
}

let backendRagActive = 0
export function getBackendRagActiveCount(): number { return backendRagActive }

export async function backendRagChat(sessionId: string, message: string, meetingId?: string): Promise<unknown> {
  backendRagActive++
  try { return await runBackendRagChat(sessionId, message, meetingId) }
  finally { backendRagActive-- }
}

async function runBackendRagChat(sessionId: string, message: string, meetingId?: string): Promise<unknown> {
  requireAssistant()
  if (!queryOne('SELECT id FROM conversations WHERE id = ?', [sessionId])) throw new Error('Conversation not found')
  // Restore only on demand, using the same store and configured dispatcher.
  // No index rebuild, corpus backfill, or alternate provider is requested here.
  markVectorStartupLoading()
  try {
    await getVectorStore().initialize()
    markVectorStartupReady(getVectorStore().getEligibleDocumentCount())
  } catch (error) { markVectorStartupFailed(error); throw error }
  const rag = getRAGService()
  const response = await rag.chat(sessionId, message, meetingId)
  if (!response.generationId) return { status: 'error', error: response.error ?? 'No generation returned' }
  // The raw chat response must never escape before the post-generation
  // provenance check used by the assistant persist/read boundary.
  const answer = rag.consumeAssistantAnswer(sessionId, response.generationId)
  if (answer.kind !== 'rag') return { status: 'error', error: response.error ?? 'No grounded answer returned' }
  if (isProvenanceExcluded(answer.prov)) return { status: 'redacted', answer: REDACTED_ANSWER, sources: [] }
  const validated = revalidateStoredSources(packSources(answer.sources, answer.prov), 'assistant')
  if (validated.redactContent) return { status: 'redacted', answer: REDACTED_ANSWER, sources: [] }
  return { status: 'ok', answer: answer.content, sources: JSON.parse(validated.sources ?? '[]'), provenance: answer.prov }
}

export function cancelBackendRag(sessionId: string): boolean {
  return getRAGService().cancelRequest(sessionId)
}
