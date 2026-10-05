// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('../config', () => ({ getConfig: () => ({ embeddings: { ollamaModel: 'chosen-model' }, brains: { openaiCompatible: { embeddingModel: 'server-model' } } }) }))
vi.mock('../brains', () => ({ getBrainRouter: () => ({}) }))
import { getEmbeddingsService } from '../embeddings'
describe('trace embedding model metadata', () => {
  it.each([
    ['gemini-api', 'gemini-embedding-001'], ['local-onnx-embed', 'Nemotron-3-Embed-1B'],
    ['ollama', 'chosen-model'], ['openai-compatible', 'server-model'], [null, null]
  ])('describes %s without probing a provider', (provider, model) => {
    expect(getEmbeddingsService().modelForProvider(provider)).toBe(model)
  })
})
