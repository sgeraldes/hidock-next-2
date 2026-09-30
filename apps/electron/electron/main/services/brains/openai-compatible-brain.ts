/**
 * OpenAI-compatible brain: any server that speaks the OpenAI REST protocol, on this machine or on
 * the local network. LM Studio, the llama.cpp server, vLLM and Ollama's own /v1 all do. Ollama also
 * has its own brain (ollama-brain.ts); this one is for everything else, and for Ollama on another
 * machine.
 *
 * Capabilities: generate, chat, embed. No audio, no agent.
 *
 * Semantics the router relies on (same as OllamaBrain): generate and chat return null when the
 * server is down, errors or answers with something unusable; embed returns one entry per text and
 * a null for every text it could not embed. Nothing throws.
 *
 * Confidentiality: the prompt goes in the request body only. It is never in the URL and never in the
 * log; a failure logs the path and the HTTP status. The optional key goes in the Authorization
 * header and comes from the credential store (brain 'openai-compatible', field 'apiKey').
 *
 * Privacy: the descriptor says the data stays on the machine only for a loopback address. A server
 * on the network is still "leaves the machine", because the Local only preset promises more than
 * "somewhere in the house".
 */
import { getConfig } from '../config'
import { getBrainCredentialStore } from './brain-credential-store'
import { caps, type HarnessDescriptor, type ModelInfo } from './descriptor'
import { recordHarnessUsage } from './harness-usage'
import { eligibleToGenerate } from './eligibility'
import type {
  AIBrain,
  BrainAuthStatus,
  BrainCapability,
  BrainMessage,
  EmbedOptions,
  GenerateOptions
} from './types'

const CAPABILITIES: ReadonlySet<BrainCapability> = new Set<BrainCapability>(['generate', 'chat', 'embed'])

const REQUEST_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 4_000
const EMBED_BATCH = 64

export interface OpenAiCompatibleSettings {
  /** Includes the version path, for example http://localhost:1234/v1 */
  baseUrl: string
  /** Chat model. Empty means the server picks (LM Studio uses the model that is loaded). */
  model: string
  embeddingModel: string
}

export const DEFAULT_OPENAI_COMPATIBLE_SETTINGS: OpenAiCompatibleSettings = {
  baseUrl: 'http://localhost:1234/v1',
  model: '',
  embeddingModel: ''
}

export interface OpenAiCompatibleDeps {
  fetchImpl?: typeof fetch
  getSettings?: () => OpenAiCompatibleSettings
  getApiKey?: () => string
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>
  model?: unknown
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
}

interface EmbeddingsResponse {
  data?: Array<{ index?: unknown; embedding?: unknown }>
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>
}

/** True for localhost, 127.0.0.1 and ::1 only. Parsed, so localhost.evil.example does not pass. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

function withSystemPrompt(messages: BrainMessage[], systemPrompt?: string): BrainMessage[] {
  const hasSystem = messages.some((m) => m.role === 'system')
  return systemPrompt && !hasSystem ? [{ role: 'system', content: systemPrompt }, ...messages] : messages
}

function defaultGetSettings(): OpenAiCompatibleSettings {
  const saved = getConfig().brains?.openaiCompatible
  return { ...DEFAULT_OPENAI_COMPATIBLE_SETTINGS, ...(saved ?? {}) }
}

function defaultGetApiKey(): string {
  try {
    return getBrainCredentialStore().getSecret('openai-compatible', 'apiKey')?.trim() ?? ''
  } catch {
    return ''
  }
}

export class OpenAiCompatibleBrain implements AIBrain {
  readonly id = 'openai-compatible' as const
  readonly label = 'Local server (OpenAI-compatible)'

  private readonly fetchImpl: typeof fetch
  private readonly settings: () => OpenAiCompatibleSettings
  private readonly apiKey: () => string

  constructor(deps: OpenAiCompatibleDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.settings = deps.getSettings ?? defaultGetSettings
    this.apiKey = deps.getApiKey ?? defaultGetApiKey
  }

  capabilities(): ReadonlySet<BrainCapability> {
    return CAPABILITIES
  }

  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'local',
      vendor: 'local',
      dataLeavesMachine: !isLoopbackUrl(this.settings().baseUrl),
      latency: 'medium',
      capabilities: caps('text', 'embedding'),
      effort: { kind: 'none' },
      needs: 'running-server',
      modelSelectable: true
    }
  }

  async authStatus(): Promise<BrainAuthStatus> {
    const models = await this.fetchModels()
    if (models === null) {
      return { configured: false, method: 'none', detail: `not reachable at ${this.settings().baseUrl}` }
    }
    return {
      configured: true,
      method: this.apiKey() ? 'api-key' : 'none',
      detail: `${models.length} model${models.length === 1 ? '' : 's'} available`
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.fetchModels()) ?? []
  }

  async generate(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    const chatMessages = withSystemPrompt(messages, opts.systemPrompt)
    if (chatMessages.length === 0) return null
    const body: Record<string, unknown> = { messages: chatMessages, stream: false }
    const model = opts.model || this.settings().model
    if (model) body.model = model
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
    if (opts.json) body.response_format = { type: 'json_object' }
    const startedAt = Date.now()
    const data = (await this.post('/chat/completions', body, opts.signal)) as ChatCompletion | null
    if (data) {
      recordHarnessUsage({
        harness: this.id,
        model: (typeof data.model === 'string' && data.model) || model || undefined,
        inputTokens: typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : undefined,
        outputTokens: typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : undefined,
        durationMs: Date.now() - startedAt
      })
    }
    const content = data?.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() ? content : null
  }

  async chat(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    return this.generate(messages, opts)
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<(number[] | null)[]> {
    if (texts.length === 0) return []
    const model = this.settings().embeddingModel
    const out: (number[] | null)[] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      // Re-checked before EACH request, like the other embed adapters (ADV43-2).
      if (!eligibleToGenerate(opts.shouldGenerate)) break
      const slice = texts.slice(i, i + EMBED_BATCH)
      const data = (await this.post('/embeddings', { ...(model ? { model } : {}), input: slice })) as EmbeddingsResponse | null
      const byIndex = new Map<number, number[]>()
      ;(data?.data ?? []).forEach((item, position) => {
        if (!Array.isArray(item.embedding)) return
        byIndex.set(typeof item.index === 'number' ? item.index : position, item.embedding as number[])
      })
      for (let j = 0; j < slice.length; j++) out.push(byIndex.get(j) ?? null)
    }
    while (out.length < texts.length) out.push(null)
    return out
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const key = this.apiKey()
    if (key) headers.Authorization = `Bearer ${key}`
    return headers
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown | null> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(joinUrl(this.settings().baseUrl, path), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      if (!res.ok) {
        console.error(`[OpenAiCompatibleBrain] ${path} returned HTTP ${res.status}`)
        return null
      }
      return (await res.json()) as unknown
    } catch (e) {
      // An abort by the caller is not a failure worth a log line. The message never holds the prompt.
      if (!signal?.aborted) {
        console.error(`[OpenAiCompatibleBrain] ${path} failed:`, e instanceof Error ? e.message : String(e))
      }
      return null
    }
  }

  private async fetchModels(): Promise<ModelInfo[] | null> {
    try {
      const res = await this.fetchImpl(joinUrl(this.settings().baseUrl, '/models'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const data = (await res.json()) as ModelsResponse
      return (data.data ?? [])
        .filter((m): m is { id: string } => typeof m.id === 'string' && m.id.length > 0)
        .map((m) => ({ id: m.id }))
    } catch {
      return null
    }
  }
}
