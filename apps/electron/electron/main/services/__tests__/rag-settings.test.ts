/**
 * The RAG numbers in Settings are read now (they were saved and ignored), and
 * at their defaults they reproduce the numbers used before.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_RAG_SETTINGS, applyRagSettings, contextChunksFor, ragSettings } from '../rag-settings'

beforeEach(() => {
  applyRagSettings({})
})

describe('rag settings', () => {
  it('the default context window gives 5, 10 and 16 passages, as before', () => {
    expect(contextChunksFor('question')).toBe(5)
    expect(contextChunksFor('topics')).toBe(10)
    expect(contextChunksFor('report')).toBe(16)
  })

  it('a smaller window reads fewer passages, never none', () => {
    applyRagSettings({ chat: { maxContextChunks: 4 } })
    expect([contextChunksFor('question'), contextChunksFor('topics'), contextChunksFor('report')]).toEqual([2, 4, 6])
    applyRagSettings({ chat: { maxContextChunks: 1 } })
    expect(contextChunksFor('question')).toBe(1)
  })

  it('reads the chunk size and overlap, and keeps them in range', () => {
    expect(applyRagSettings({ embeddings: { chunkSize: 800, chunkOverlap: 100 } })).toMatchObject({ chunkSize: 800, chunkOverlap: 100 })
    // An overlap at or above the chunk size would never advance.
    expect(applyRagSettings({ embeddings: { chunkSize: 200, chunkOverlap: 500 } })).toMatchObject({ chunkSize: 200, chunkOverlap: 100 })
    expect(applyRagSettings({ embeddings: { chunkSize: 'x' } })).toMatchObject({ chunkSize: DEFAULT_RAG_SETTINGS.chunkSize })
    expect(ragSettings().chunkOverlap).toBe(DEFAULT_RAG_SETTINGS.chunkOverlap)
  })
})
