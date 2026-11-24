import { getConfig } from '../config'
import { modelHostFetch } from '../model-host-transport'
import { caps, type HarnessDescriptor } from './descriptor'
import { eligibleToGenerate } from './eligibility'
import { recordHarnessUsage } from './harness-usage'
import type { AIBrain, BrainAuthStatus, BrainCapability, BrainMessage, GenerateOptions } from './types'

export interface RemoteGenerationCapability {
  ready: true
  model: string
  modelVersion: string
  maxContextTokens: number
  maxOutputTokens: number
}

function connection() {
  const config = getConfig().transcription
  const url = new URL(config.modelHostUrl || '')
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Managed generation requires HTTPS')
  if (!config.modelHostToken) throw new Error('Model host is not paired')
  return { base: url.href.replace(/\/+$/, ''), token: config.modelHostToken }
}

export async function readRemoteGenerationCapability(): Promise<RemoteGenerationCapability> {
  const target = connection()
  const response = await modelHostFetch(`${target.base}/health`, {
    headers: { authorization: `Bearer ${target.token}` }, signal: AbortSignal.timeout(5000)
  })
  if (!response.ok) throw new Error(`Managed generation health unavailable (${response.status})`)
  const capability = (await response.json()).textGeneration
  if (capability?.ready !== true || typeof capability.model !== 'string' || !capability.model
      || typeof capability.modelVersion !== 'string' || !capability.modelVersion
      || !Number.isSafeInteger(capability.maxContextTokens) || capability.maxContextTokens < 1
      || !Number.isSafeInteger(capability.maxOutputTokens) || capability.maxOutputTokens < 1) {
    throw new Error('Managed generation model is not ready')
  }
  return capability
}

export class ModelHostGenerateBrain implements AIBrain {
  readonly id = 'model-host-generate' as const
  readonly label = 'Model Host — text generation'
  capabilities(): ReadonlySet<BrainCapability> { return new Set(['generate', 'chat']) }
  descriptor(): HarnessDescriptor {
    return { id: this.id, label: this.label, kind: 'special', vendor: 'model-host', dataLeavesMachine: true,
      latency: 'medium', capabilities: caps('text'), effort: { kind: 'none' },
      needs: 'running-server', modelSelectable: false }
  }
  async authStatus(): Promise<BrainAuthStatus> {
    try {
      const capability = await readRemoteGenerationCapability()
      const bound = getConfig().brains.modelHostGeneration?.modelVersion
      return { configured: !!bound && bound === capability.modelVersion, method: 'api-key',
        detail: !bound ? 'Select and bind the managed generation model first'
          : bound !== capability.modelVersion ? 'Managed generation model changed; select it again'
            : 'Managed generation model ready' }
    } catch { return { configured: false, method: 'api-key', detail: 'Managed generation unavailable' } }
  }
  chat(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    return this.generate(messages, opts)
  }
  async generate(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    if (!eligibleToGenerate(opts.shouldGenerate)) return null
    opts.signal?.throwIfAborted()
    const config = getConfig().brains
    const expectedModelVersion = config.modelHostGeneration?.modelVersion
    if (!config.enabled[this.id] || !expectedModelVersion) throw new Error('Enable and bind managed generation first')
    const input = opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }, ...messages] : messages
    if (!input.length || input.length > 64 || input.some(m => !['system', 'user', 'assistant'].includes(m.role)
        || typeof m.content !== 'string') || Buffer.byteLength(JSON.stringify(input), 'utf8') > 65536) {
      throw new Error('Managed generation messages exceed bounded input')
    }
    const target = connection()
    const capability = await readRemoteGenerationCapability()
    if (capability.modelVersion !== expectedModelVersion) throw new Error('Managed model changed; refused before text upload')
    if (opts.model && opts.model !== capability.model) throw new Error('Requested model is not the validated managed model')
    const maxOutputTokens = opts.maxTokens ?? Math.min(1024, capability.maxOutputTokens)
    const temperature = opts.temperature ?? 0.2
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1
        || maxOutputTokens > Math.min(2048, capability.maxOutputTokens)
        || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error('Managed generation options exceed validated limits')
    }
    const unchanged = () => getConfig().brains.enabled[this.id]
      && getConfig().brains.modelHostGeneration?.modelVersion === expectedModelVersion
      && JSON.stringify(connection()) === JSON.stringify(target)
    if (!eligibleToGenerate(opts.shouldGenerate)) return null
    if (!unchanged()) throw new Error('Managed generation selection changed before upload')
    const started = Date.now()
    const deadline = AbortSignal.timeout(120000)
    const response = await modelHostFetch(`${target.base}/v1/generate`, {
      method: 'POST', headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      signal: opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline,
      body: JSON.stringify({ expectedModelVersion, messages: input, temperature, maxOutputTokens, jsonMode: !!opts.json })
    })
    if (!response.ok) throw new Error(`Managed generation failed (${response.status}); no fallback`)
    const result = await response.json()
    if (result.model !== capability.model || result.modelVersion !== expectedModelVersion
        || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 262144) {
      throw new Error('Managed generation response failed validation')
    }
    if (opts.json) { try { JSON.parse(result.text) } catch { throw new Error('Managed generation returned invalid JSON') } }
    if (!unchanged()) throw new Error('Managed generation selection changed during inference')
    if (!eligibleToGenerate(opts.shouldGenerate)) return null
    // The shared collector treats absent tokens as zero. Do not submit partial/unknown usage to it.
    if ([result.inputTokens, result.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
      recordHarnessUsage({ harness: this.id, model: result.model, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, durationMs: Date.now() - started, reportedCostUsd: 0 })
    }
    return result.text
  }
}

