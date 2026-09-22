import { availableParallelism, constants, setPriority } from 'os'
import { LocalEmbedderService, type EmbedPurpose } from './services/local-embedder-runtime'

// CPU is the portable backend. Native imports and session creation must never
// execute on Electron's main thread, including their synchronous portions.
try { setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* platform best effort */ }
const embedder = new LocalEmbedderService(undefined, process.argv[2], false, (name, elapsedMs) => {
  process.parentPort?.postMessage({ type: 'timing', name, elapsedMs })
})
process.env.HIDOCK_EMBED_CPU_PERCENT = process.argv[3] || '50'
process.parentPort?.on('message', async ({ data }: { data: { id: number; texts: string[]; purpose: EmbedPurpose } }) => {
  try {
    const vectors = await embedder.embed(data.texts, data.purpose)
    process.parentPort?.postMessage({ id: data.id, vectors, backend: embedder.activeBackend(),
      cpuThreads: Math.max(1, Math.floor(availableParallelism() *
        Math.max(10, Math.min(75, Number(process.env.HIDOCK_EMBED_CPU_PERCENT) || 50)) / 100)) })
  } catch (error) {
    process.parentPort?.postMessage({ id: data.id, vectors: null, error: String(error) })
  }
})
