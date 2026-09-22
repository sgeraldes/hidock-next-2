/**
 * Local Nemotron embedding runtime, loaded in an Electron utility process.
 * Native imports, tokenizer/session initialization and inference stay off the
 * main process. Production currently uses portable CPU execution with bounded
 * threads and spinning disabled; injected dependencies retain GPU fallback
 * coverage for a future hardware-qualified acceleration policy.
 * Models remain local; the runtime never downloads missing assets.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { availableParallelism } from 'os'

export type EmbedPurpose = 'query' | 'passage'

const MAX_SEQ_LENGTH = 512
const BATCH_SIZE = 16
const EMBEDDING_DIMS = 2048

const PREFIXES: Record<EmbedPurpose, string> = {
  query: 'query: ',
  passage: 'passage: ',
}

// Structural types for the two runtime deps — keeps the service testable with
// plain fakes and avoids importing the (heavy) modules at type level only.
export interface EmbedTokenizer {
  (
    texts: string[],
    options: { padding: boolean; truncation: boolean; max_length: number }
  ): Promise<{ input_ids: { data: ArrayLike<number>; dims: number[] }; attention_mask: { data: ArrayLike<number>; dims: number[] } }>
}

export interface EmbedSession {
  inputNames: string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number>; dims: number[] }>>
}

/** Injectable factories — tests substitute fakes; production wires the real modules. */
export interface EmbedderDeps {
  loadTokenizer: (modelDir: string) => Promise<EmbedTokenizer>
  createSession: (onnxPath: string, provider: 'webgpu' | 'cpu') => Promise<EmbedSession>
  createTensor: (data: BigInt64Array, dims: number[]) => unknown
}

async function defaultLoadTokenizer(modelDir: string): Promise<EmbedTokenizer> {
  const { AutoTokenizer, env } = await import('@huggingface/transformers')
  // Local model only — never fall back to a silent HF download in the app.
  env.allowRemoteModels = false
  const tokenizer = await AutoTokenizer.from_pretrained(modelDir)
  return tokenizer as unknown as EmbedTokenizer
}

async function defaultCreateSession(onnxPath: string, provider: 'webgpu' | 'cpu'): Promise<EmbedSession> {
  const ort = await import('onnxruntime-node')
  const executionProviders = provider === 'webgpu' ? ['webgpu', 'cpu'] : ['cpu']
  const session = await ort.InferenceSession.create(onnxPath, {
    executionProviders,
    intraOpNumThreads: Math.max(1, Math.floor(availableParallelism() *
      Math.max(10, Math.min(75, Number(process.env.HIDOCK_EMBED_CPU_PERCENT) || 50)) / 100)),
    interOpNumThreads: 1,
    executionMode: 'sequential',
    extra: { session: { 'intra_op.allow_spinning': '0', 'inter_op.allow_spinning': '0' } },
  })
  return session as unknown as EmbedSession
}

async function defaultCreateTensor(data: BigInt64Array, dims: number[]): Promise<unknown> {
  const { Tensor } = await import('onnxruntime-node')
  return new Tensor('int64', data, dims)
}

/** Attention-masked mean pooling + L2 normalization (matches the reference stack bit-for-bit). */
export function meanPoolNormalize(
  hidden: ArrayLike<number>,
  dims: number[],
  mask: ArrayLike<number>
): number[][] {
  const [batch, seq, hid] = dims
  const out: number[][] = []
  for (let b = 0; b < batch; b++) {
    const vec = new Array<number>(hid).fill(0)
    let count = 0
    for (let s = 0; s < seq; s++) {
      if (!mask[b * seq + s]) continue
      count++
      for (let h = 0; h < hid; h++) vec[h] += hidden[(b * seq + s) * hid + h]
    }
    let norm = 0
    for (let h = 0; h < hid; h++) {
      vec[h] /= Math.max(count, 1)
      norm += vec[h] * vec[h]
    }
    norm = Math.sqrt(norm) || 1
    for (let h = 0; h < hid; h++) vec[h] /= norm
    out.push(vec)
  }
  return out
}

class LocalEmbedderService {
  private tokenizer: EmbedTokenizer | null = null
  private session: EmbedSession | null = null
  private loading: Promise<boolean> | null = null
  private backend: 'webgpu' | 'cpu' | null = null
  /** Serializes session runs (batched reindex + query-time calls share one session). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly deps: EmbedderDeps = {
      loadTokenizer: defaultLoadTokenizer,
      createSession: defaultCreateSession,
      createTensor: defaultCreateTensor,
    },
    private readonly directory: string = '',
    private readonly preferGpu = true,
    private readonly onTiming?: (name: string, elapsedMs: number) => void,
  ) {}

  private async timed<T>(name: string, action: () => Promise<T>): Promise<T> {
    const start = Date.now()
    try { return await action() } finally { this.onTiming?.(name, Date.now() - start) }
  }

  modelDir(): string {
    return this.directory
  }

  /** Cheap local fs check — safe for authStatus / router selection (no probe). */
  isModelPresent(): boolean {
    return existsSync(join(this.modelDir(), 'onnx', 'model.onnx'))
  }

  /** Which execution provider the loaded session is using (null until loaded). */
  activeBackend(): 'webgpu' | 'cpu' | null {
    return this.backend
  }

  embeddingDims(): number {
    return EMBEDDING_DIMS
  }

  async initialize(): Promise<boolean> {
    if (this.session) return true
    if (this.loading) return this.loading
    this.loading = (async () => {
      if (!this.isModelPresent()) return false
      const dir = this.modelDir()
      try {
        this.tokenizer = await this.timed('tokenizer-load', () => this.deps.loadTokenizer(dir))
        try {
          const provider = this.preferGpu ? 'webgpu' : 'cpu'
          this.session = await this.timed('onnx-session-load', () =>
            this.deps.createSession(join(dir, 'onnx', 'model.onnx'), provider))
          this.backend = provider
        } catch (gpuErr) {
          console.warn('[LocalEmbedder] WebGPU session failed, falling back to CPU:', gpuErr)
          this.session = await this.deps.createSession(join(dir, 'onnx', 'model.onnx'), 'cpu')
          this.backend = 'cpu'
        }
        console.log(`[LocalEmbedder] Nemotron-3-Embed loaded (${this.backend} backend)`)
        return true
      } catch (e) {
        console.error('[LocalEmbedder] Initialization failed:', e)
        this.session = null
        this.tokenizer = null
        this.backend = null
        return false
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  /**
   * Embed texts with the model's asymmetric prefixes. Returns one 2048-dim
   * L2-normalized vector per input text. Returns null when the model is
   * absent/unloadable (the brain adapter treats that as "provider
   * unavailable"). Throws never — session errors yield null.
   */
  async embed(texts: string[], purpose: EmbedPurpose = 'passage'): Promise<number[][] | null> {
    if (texts.length === 0) return []
    if (!(await this.initialize())) return null

    const work = async (): Promise<number[][] | null> => {
      const prefix = PREFIXES[purpose]
      const out: number[][] = []
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE).map((t) => prefix + t)
        try {
          const enc = await this.tokenizer!(batch, {
            padding: true,
            truncation: true,
            max_length: MAX_SEQ_LENGTH,
          })
          const [b, seq] = enc.input_ids.dims
          const toI64 = (src: ArrayLike<number>) => {
            const dst = new BigInt64Array(src.length)
            for (let k = 0; k < src.length; k++) dst[k] = BigInt(src[k])
            return dst
          }
          const results = await this.timed('onnx-inference', async () => this.session!.run({
            input_ids: await this.deps.createTensor(toI64(enc.input_ids.data), [b, seq]),
            attention_mask: await this.deps.createTensor(toI64(enc.attention_mask.data), [b, seq]),
          }))
          const hidden = results['last_hidden_state']
          out.push(...meanPoolNormalize(hidden.data, hidden.dims, enc.attention_mask.data))
        } catch (e) {
          console.error(`[LocalEmbedder] embed failed on batch ${i / BATCH_SIZE}:`, e)
          return null
        }
      }
      return out
    }

    const run = this.queue.then(work)
    this.queue = run.catch(() => undefined)
    return run
  }
}

export { LocalEmbedderService }
