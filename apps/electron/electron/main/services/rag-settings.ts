/**
 * The RAG numbers people can change in Settings (embeddings.chunkSize,
 * embeddings.chunkOverlap, chat.maxContextChunks). The config was saved but
 * never read (settings inventory, 28-sep-2026). config.ts refreshes these on
 * every load and save; the vector store and the assistant read them here, so
 * neither imports the config (and Electron) directly.
 */

export interface RagSettings {
  /** Characters per indexed chunk. */
  chunkSize: number
  /** Characters repeated between neighbouring chunks. */
  chunkOverlap: number
  /** Passages read for a topic question; ordinary questions use half, reports 1.6 times. */
  maxContextChunks: number
}

export const DEFAULT_RAG_SETTINGS: RagSettings = { chunkSize: 500, chunkOverlap: 50, maxContextChunks: 10 }

let current: RagSettings = { ...DEFAULT_RAG_SETTINGS }

function whole(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

export function applyRagSettings(config: {
  embeddings?: { chunkSize?: unknown; chunkOverlap?: unknown }
  chat?: { maxContextChunks?: unknown }
}): RagSettings {
  const chunkSize = whole(config.embeddings?.chunkSize, 100, 4000, DEFAULT_RAG_SETTINGS.chunkSize)
  current = {
    chunkSize,
    // Overlap below the chunk size, or chunking never advances.
    chunkOverlap: whole(config.embeddings?.chunkOverlap, 0, Math.floor(chunkSize / 2), DEFAULT_RAG_SETTINGS.chunkOverlap),
    maxContextChunks: whole(config.chat?.maxContextChunks, 1, 20, DEFAULT_RAG_SETTINGS.maxContextChunks)
  }
  return current
}

export function ragSettings(): RagSettings {
  return current
}

/**
 * Passages to retrieve for a question. At the default of 10 this is 5 for an
 * ordinary question, 10 for topics and 16 for a report, the numbers used
 * before the setting was read.
 */
export function contextChunksFor(intent: string, maxContextChunks = current.maxContextChunks): number {
  if (intent === 'report') return Math.max(1, Math.round(maxContextChunks * 1.6))
  if (intent === 'topics') return maxContextChunks
  return Math.max(1, Math.round(maxContextChunks / 2))
}
