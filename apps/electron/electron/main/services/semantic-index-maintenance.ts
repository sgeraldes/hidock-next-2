import { randomUUID } from 'node:crypto'
import { getDatabase, queryOne, queryAll } from './database'
import { getConfig } from './config'
import { isFeatureEnabled } from './feature-gate'
import { isRecoveryMode } from '../recovery-mode'
import { isRecordingEligible } from './recording-eligibility'
import { getVectorStore } from './vector-store'
import { readRemoteEmbeddingSpace } from './brains/model-host-embed-brain'

type State =
  'idle' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'interrupted'
export interface SemanticIndexStatus {
  state: State
  runId?: string
  provider?: string
  spaceId?: string
  hostUrl?: string
  completedRecordings: number
  indexedChunks: number
  batches: number
  maxRecordings: number
  maxBatches: number
  activePartitionRows: number
  otherPartitionRows: number
  hostReady: boolean | null
  error?: string
}
interface Run {
  id: string
  state: State
  provider: string
  space: string
  host: string
  cursor: string
  current: string | null
  recordings: number
  chunks: number
  batches: number
  max_recordings: number
  max_batches: number
  error: string | null
}

/** Explicit maintenance only. Construction and startup never submit work. */
export class SemanticIndexMaintenance {
  private owner: Promise<void> | null = null
  private ready: boolean | null = null
  private schema(): void {
    getDatabase().run(`CREATE TABLE IF NOT EXISTS semantic_index_runs (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, provider TEXT NOT NULL, space TEXT NOT NULL, host TEXT NOT NULL,
      cursor TEXT NOT NULL DEFAULT '', current TEXT, recordings INTEGER NOT NULL DEFAULT 0,
      chunks INTEGER NOT NULL DEFAULT 0, batches INTEGER NOT NULL DEFAULT 0,
      max_recordings INTEGER NOT NULL, max_batches INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL)`)
  }
  private latest(): Run | undefined {
    this.schema()
    return queryOne<Run>('SELECT * FROM semantic_index_runs ORDER BY created_at DESC, rowid DESC LIMIT 1')
  }
  private save(run: Run): void {
    getDatabase().run(
      `UPDATE semantic_index_runs SET state=?,cursor=?,current=?,recordings=?,chunks=?,batches=?,error=? WHERE id=?`,
      [run.state, run.cursor, run.current, run.recordings, run.chunks, run.batches, run.error, run.id]
    )
  }
  private selected(): { provider: string; space: string; host: string } {
    const config = getConfig()
    const space = config.brains.modelHostEmbedding?.spaceId
    if (
      config.brains.taskRouting.embed !== 'model-host-embed' ||
      !config.brains.enabled['model-host-embed'] ||
      !space
    ) {
      throw new Error('Select and bind Model Host semantic search first')
    }
    return {
      provider: `model-host-embed:${space}`,
      space,
      host: config.transcription.modelHostUrl || ''
    }
  }
  private check(run: Run): void {
    if (isRecoveryMode()) throw new Error('Semantic maintenance is unavailable in recovery mode')
    if (!isFeatureEnabled('assistant')) throw new Error('Assistant feature is disabled')
    const selected = this.selected()
    if (selected.provider !== run.provider || selected.host !== run.host)
      throw new Error('Semantic host or space changed; run stopped')
  }
  status(): SemanticIndexStatus {
    const run = this.latest()
    if (run && !this.owner && ['running', 'pausing', 'cancelling'].includes(run.state)) {
      run.state = 'interrupted'
      run.error = 'Previous process stopped; explicit Resume required'
      this.save(run)
    }
    let selected: ReturnType<SemanticIndexMaintenance['selected']> | undefined
    try {
      selected = this.selected()
    } catch {
      /* no usable selection */
    }
    const provider = selected?.provider ?? run?.provider
    const counts = queryOne("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vector_embeddings'")
      ? queryAll<{ embed_provider: string; n: number }>(
          'SELECT embed_provider,COUNT(*) n FROM vector_embeddings GROUP BY embed_provider'
        )
      : []
    return {
      state: run?.state ?? 'idle',
      runId: run?.id,
      provider: run?.provider ?? provider,
      spaceId: run?.space ?? selected?.space,
      hostUrl: run?.host ?? selected?.host,
      completedRecordings: run?.recordings ?? 0,
      indexedChunks: run?.chunks ?? 0,
      batches: run?.batches ?? 0,
      maxRecordings: run?.max_recordings ?? 1,
      maxBatches: run?.max_batches ?? 4,
      activePartitionRows: counts.filter((c) => c.embed_provider === provider).reduce((n, c) => n + c.n, 0),
      otherPartitionRows: counts.filter((c) => c.embed_provider !== provider).reduce((n, c) => n + c.n, 0),
      hostReady: this.ready,
      error: run?.error ?? undefined
    }
  }
  start(options: { maxRecordings?: number; maxBatches?: number } = {}): SemanticIndexStatus {
    const old = this.latest()
    if (this.owner || (old && !['completed', 'cancelled'].includes(old.state)))
      throw new Error('Resume or cancel the existing maintenance run')
    const maxRecordings = options.maxRecordings ?? 1,
      maxBatches = options.maxBatches ?? 4
    if (
      !Number.isInteger(maxRecordings) ||
      maxRecordings < 1 ||
      maxRecordings > 20 ||
      !Number.isInteger(maxBatches) ||
      maxBatches < 1 ||
      maxBatches > 100
    )
      throw new Error('Invalid maintenance budget')
    const selected = this.selected()
    const run: Run = {
      id: randomUUID(),
      state: 'running',
      ...selected,
      cursor: '',
      current: null,
      recordings: 0,
      chunks: 0,
      batches: 0,
      max_recordings: maxRecordings,
      max_batches: maxBatches,
      error: null
    }
    this.check(run)
    getDatabase().run(
      'INSERT INTO semantic_index_runs (id,state,provider,space,host,max_recordings,max_batches,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [run.id, run.state, run.provider, run.space, run.host, maxRecordings, maxBatches, Date.now()]
    )
    this.launch(run)
    return this.status()
  }
  control(action: 'pause' | 'resume' | 'cancel', id: string): SemanticIndexStatus {
    const run = this.latest()
    if (!run || run.id !== id) throw new Error('Maintenance run not found')
    if (action === 'resume') {
      if (this.owner || !['paused', 'failed', 'interrupted'].includes(run.state))
        throw new Error('Run cannot resume in its current state')
      this.check(run)
      run.state = 'running'
      run.error = null
      this.save(run)
      this.launch(run)
    } else if (action === 'pause') {
      if (run.state !== 'running') throw new Error('Only running maintenance can pause')
      run.state = 'pausing'
      this.save(run)
    } else {
      if (['completed', 'cancelled'].includes(run.state)) return this.status()
      run.state = this.owner ? 'cancelling' : 'cancelled'
      this.save(run)
    }
    return this.status()
  }
  async waitForIdle(): Promise<void> {
    await this.owner
  }
  private launch(run: Run): void {
    this.ready = null
    this.owner = Promise.resolve()
      .then(() => this.execute(run))
      .finally(() => {
        this.owner = null
      })
  }
  private async execute(run: Run): Promise<void> {
    const initialBatches = run.batches,
      initialRecordings = run.recordings
    const state = (): State => queryOne<Run>('SELECT * FROM semantic_index_runs WHERE id=?', [run.id])!.state
    const mayPersist = (): boolean => {
      this.check(run)
      return state() !== 'cancelling' && !!run.current && isRecordingEligible(run.current)
    }
    try {
      this.check(run)
      const profile = await readRemoteEmbeddingSpace()
      this.ready = profile.spaceId === run.space
      if (!this.ready) throw new Error('Host semantic space changed or unavailable')
      for (;;) {
        this.check(run)
        const requested = state()
        if (requested === 'cancelling') {
          run.state = 'cancelled'
          break
        }
        if (
          requested === 'pausing' ||
          run.batches - initialBatches >= run.max_batches ||
          run.recordings - initialRecordings >= run.max_recordings
        ) {
          run.state = 'paused'
          break
        }
        if (!run.current) {
          const candidates = queryAll<{ id: string }>(
            `SELECT r.id FROM recordings r WHERE r.id>? AND EXISTS
            (SELECT 1 FROM transcripts t WHERE t.recording_id=r.id AND trim(coalesce(t.full_text,''))!='') ORDER BY r.id LIMIT 32`,
            [run.cursor]
          )
          if (!candidates.length) {
            run.state = 'completed'
            break
          }
          for (const row of candidates) {
            if (isRecordingEligible(row.id)) {
              run.current = row.id
              break
            }
            run.cursor = row.id
          }
          this.save(run)
          if (!run.current) {
            await new Promise<void>((resolve) => setImmediate(resolve))
            continue
          }
        }
        if (!isRecordingEligible(run.current)) {
          run.cursor = run.current
          run.current = null
          this.save(run)
          continue
        }
        const transcript = queryOne<{ full_text: string }>('SELECT full_text FROM transcripts WHERE recording_id=?', [
          run.current
        ])
        if (!transcript?.full_text) {
          run.cursor = run.current
          run.current = null
          this.save(run)
          continue
        }
        await getVectorStore().indexTranscript(transcript.full_text, {
          recordingId: run.current,
          expectedProviderId: run.provider,
          maxBatches: 1,
          shouldGenerate: mayPersist,
          shouldPersist: mayPersist,
          onBatchCommitted: (chunks) => {
            run.chunks += chunks
            run.batches++
            run.state = state()
            this.save(run)
          }
        })
        if (!mayPersist()) {
          if (state() === 'cancelling') {
            run.state = 'cancelled'
            break
          }
          throw new Error('Recording eligibility changed')
        }
        const pending = queryOne('SELECT 1 FROM vector_index_pending WHERE recording_id=? AND embed_provider=?', [
          run.current,
          run.provider
        ])
        if (!pending) {
          run.recordings++
          run.cursor = run.current
          run.current = null
        }
        run.state = state()
        this.save(run)
      }
    } catch (error) {
      run.state = state() === 'cancelling' ? 'cancelled' : 'failed'
      run.error =
        run.state === 'failed'
          ? error instanceof Error
            ? error.message.slice(0, 240)
            : 'Semantic indexing failed'
          : null
    } finally {
      this.save(run)
    }
  }
}
let instance: SemanticIndexMaintenance | undefined
export function getSemanticIndexMaintenance(): SemanticIndexMaintenance {
  return (instance ??= new SemanticIndexMaintenance())
}
