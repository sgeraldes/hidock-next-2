/**
 * Ollama (local) brain — wraps the existing OllamaService.
 *
 * Preserves the exact fallback behaviour the three routers relied on:
 *   - chat/generate return null when Ollama is unreachable (OllamaService
 *     already swallows errors and returns null).
 *   - embed returns an all-null array when Ollama is unavailable, matching
 *     embeddings.ts's previous "isAvailable() ? generateEmbeddings : nulls".
 *
 * Capabilities: generate, chat, embed. No audio, no agentic.
 */
import { getOllamaService } from '../ollama'
import type {
  AIBrain,
  BrainAuthStatus,
  BrainCapability,
  BrainMessage,
  EmbedOptions,
  GenerateOptions,
} from './types'
import { caps, type HarnessDescriptor, type ModelInfo } from './descriptor'
import { recordHarnessUsage } from './harness-usage'

const CAPABILITIES: ReadonlySet<BrainCapability> = new Set<BrainCapability>([
  'generate',
  'chat',
  'embed',
])

export class OllamaBrain implements AIBrain {
  readonly id = 'ollama' as const
  readonly label = 'Ollama (local)'

  capabilities(): ReadonlySet<BrainCapability> {
    return CAPABILITIES
  }

  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'local',
      vendor: 'local',
      dataLeavesMachine: false,
      latency: 'medium',
      capabilities: caps('text', 'embedding'),
      effort: { kind: 'none' },
      needs: 'running-server',
      modelSelectable: true
    }
  }

  async authStatus(): Promise<BrainAuthStatus> {
    let available = false
    try {
      available = await getOllamaService().isAvailable()
    } catch {
      available = false
    }
    return {
      configured: available,
      method: available ? 'cli-login' : 'none',
      detail: available ? 'running' : 'not reachable',
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const names = await getOllamaService().listModels()
      return names.map((id) => ({ id }))
    } catch {
      return []
    }
  }

  async generate(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    const prompt = messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n')
    const systemPrompt = opts.systemPrompt ?? messages.find((m) => m.role === 'system')?.content
    const startedAt = Date.now()
    const usage = { inputTokens: undefined as number | undefined, outputTokens: undefined as number | undefined }
    const out = await getOllamaService().generate(prompt, systemPrompt, {
      model: opts.model,
      onUsage: (u) => Object.assign(usage, u)
    })
    recordHarnessUsage({ harness: this.id, model: opts.model, ...usage, durationMs: Date.now() - startedAt })
    return out
  }

  async chat(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    const startedAt = Date.now()
    const usage = { inputTokens: undefined as number | undefined, outputTokens: undefined as number | undefined }
    const out = await getOllamaService().chat(messages, {
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      model: opts.model,
      onUsage: (u) => Object.assign(usage, u)
    })
    recordHarnessUsage({ harness: this.id, model: opts.model, ...usage, durationMs: Date.now() - startedAt })
    return out
  }

  /**
   * ADV43-2 (round-45) — Ollama emits ONE request per text (generateEmbeddings
   * loops over generateEmbedding). `opts.shouldGenerate` is threaded into that
   * loop and re-evaluated fail-closed before EACH per-text request, so an owner
   * exclusion committed while an earlier request is pending stops every later
   * request; already-fetched vectors are kept and the remaining texts return
   * `null` (the "no embedding available" shape callers persist as nothing).
   */
  async embed(texts: string[], opts: EmbedOptions = {}): Promise<(number[] | null)[]> {
    if (texts.length === 0) return []
    try {
      const ollama = getOllamaService()
      if (await ollama.isAvailable()) {
        return await ollama.generateEmbeddings(texts, { shouldGenerate: opts.shouldGenerate })
      }
    } catch (e) {
      console.error('[OllamaBrain] embed failed:', e)
    }
    return texts.map(() => null)
  }
}
