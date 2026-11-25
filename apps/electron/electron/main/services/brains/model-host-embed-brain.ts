import { getConfig } from '../config'
import { modelHostFetch } from '../model-host-transport'
import { eligibleToGenerate } from './eligibility'
import { caps, type HarnessDescriptor } from './descriptor'
import type { AIBrain, BrainAuthStatus, BrainCapability, BrainMessage, EmbedOptions } from './types'

export const HOST_EMBED_MODEL = 'local/nemotron-3-embed-1b'
export interface RemoteEmbeddingSpace { ready: boolean; spaceId: string; dimensions: number; model: string }
export function validEmbeddingSpace(space: RemoteEmbeddingSpace | undefined): space is RemoteEmbeddingSpace {
  return !!space && space.ready === true && space.dimensions === 2048 && space.model === HOST_EMBED_MODEL
    && /^nemotron-import-sha256:[a-f0-9]{64}$/.test(space.spaceId)
}
function connection() {
  const cfg = getConfig().transcription
  const url = new URL(cfg.modelHostUrl || '')
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Remote semantic search requires HTTPS')
  if (!cfg.modelHostToken) throw new Error('Model host is not paired')
  return { base: url.href.replace(/\/+$/, ''), token: cfg.modelHostToken }
}
/** Authenticated metadata only; no user text is sent by selection or availability checks. */
export async function readRemoteEmbeddingSpace(): Promise<RemoteEmbeddingSpace> {
  const { base, token } = connection()
  const response = await modelHostFetch(`${base}/v1/capabilities`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000)
  })
  if (!response.ok) throw new Error(`Remote semantic capability unavailable (${response.status})`)
  const capability = await response.json()
  const space = capability.semanticEmbedding
  if (capability.protocolVersion !== 1 || !validEmbeddingSpace(space)) throw new Error('Remote semantic model is not ready')
  return space
}

export class ModelHostEmbedBrain implements AIBrain {
  readonly id = 'model-host-embed' as const
  readonly label = 'Model Host — semantic search'
  capabilities(): ReadonlySet<BrainCapability> { return new Set(['embed']) }
  descriptor(): HarnessDescriptor {
    return { id: this.id, label: this.label, kind: 'special', vendor: 'model-host', dataLeavesMachine: true,
      latency: 'medium', capabilities: caps('embedding'), effort: { kind: 'none' }, needs: 'running-server', modelSelectable: false }
  }
  async authStatus(): Promise<BrainAuthStatus> {
    try {
      const space = await readRemoteEmbeddingSpace()
      const bound = getConfig().brains.modelHostEmbedding?.spaceId
      return { configured: !bound || bound === space.spaceId, method: 'api-key',
        detail: bound && bound !== space.spaceId ? 'Embedding space changed — select this role again' : 'Remote semantic model ready; explicit selection required' }
    } catch (error) { return { configured: false, method: 'api-key', detail: error instanceof Error ? error.message : 'Remote semantic model unavailable' } }
  }
  async generate(_messages: BrainMessage[]): Promise<null> { return null }
  async chat(_messages: BrainMessage[]): Promise<null> { return null }
  async embed(texts: string[], opts: EmbedOptions = {}): Promise<(number[] | null)[]> {
    if (!texts.length) return []
    const aborted = () => texts.map(() => null)
    if (!eligibleToGenerate(opts.shouldGenerate)) return aborted()
    const cfg = getConfig().brains
    const expectedSpaceId = cfg.modelHostEmbedding?.spaceId
    if (cfg.taskRouting.embed !== this.id || !cfg.enabled[this.id] || !expectedSpaceId) {
      throw new Error('Select and bind the remote semantic search role first')
    }
    if (opts.expectedProviderId !== undefined && opts.expectedProviderId !== `model-host-embed:${expectedSpaceId}`) throw new Error('Captured embedding partition does not match bound space')
    const target = connection()
    const space = await readRemoteEmbeddingSpace()
    if (space.spaceId !== expectedSpaceId) throw new Error('Remote embedding space changed; request refused before text upload')
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += 16) {
      const batch = texts.slice(start, start + 16)
      if (batch.some(text => typeof text !== 'string' || text.length > 16000)
          || Buffer.byteLength(JSON.stringify(batch), 'utf8') > 131072) throw new Error('Remote embedding input exceeds bounded batch size')
      if (!eligibleToGenerate(opts.shouldGenerate)) return aborted()
      const current = getConfig().brains
      if (current.modelHostEmbedding?.spaceId !== expectedSpaceId || current.taskRouting.embed !== this.id
          || !current.enabled[this.id] || JSON.stringify(connection()) !== JSON.stringify(target)) {
        throw new Error('Remote semantic selection changed during request')
      }
      const response = await modelHostFetch(`${target.base}/v1/embeddings`, {
        method: 'POST', headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(120000), body: JSON.stringify({ expectedSpaceId, texts: batch, purpose: opts.purpose ?? 'passage' })
      })
      if (!response.ok) throw new Error(`Remote embedding request failed (${response.status}); no fallback`)
      const result = await response.json()
      if (result.spaceId !== expectedSpaceId || result.modelVersion !== expectedSpaceId || result.model !== HOST_EMBED_MODEL || result.dimensions !== 2048
          || result.purpose !== (opts.purpose ?? 'passage') || !Array.isArray(result.vectors) || result.vectors.length !== batch.length
          || result.vectors.some((v: unknown) => !Array.isArray(v) || v.length !== 2048 || v.some(x => typeof x !== 'number' || !Number.isFinite(x))
            || Math.abs(Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) - 1) > 0.01)) {
        throw new Error('Remote embedding result failed semantic-space/vector validation')
      }
      if (!eligibleToGenerate(opts.shouldGenerate)) return aborted()
      if (getConfig().brains.modelHostEmbedding?.spaceId !== expectedSpaceId || getConfig().brains.taskRouting.embed !== this.id
          || !getConfig().brains.enabled[this.id] || JSON.stringify(connection()) !== JSON.stringify(target)) throw new Error('Remote semantic selection changed during inference')
      vectors.push(...result.vectors)
    }
    return vectors
  }
}
