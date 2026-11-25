// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
const state = vi.hoisted(() => ({ provider: 'gemini-api', excluded: new Set<string>(), pages: [] as number[] }))
vi.mock('../database', () => ({ getDatabase: vi.fn(), getDatabasePath: () => '', isRecordingProcessable: () => true }))
vi.mock('../embeddings', () => ({ getEmbeddingsService: () => ({
  activeProviderId: async () => state.provider,
  generateEmbedding: async () => Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0)
}) }))
vi.mock('../recording-eligibility', () => ({
  filterEligibleProvenanceRows: (rows: any[]) => {
    state.pages.push(rows.length)
    return rows.filter(r => !state.excluded.has(r.id))
  }, filterEligibleRecordingIds: () => ({ eligible: new Set(), failClosed: false }), isRecordingEligible: () => true
}))
import { VectorStore } from '../vector-store'

function corpus() {
  const store = new VectorStore()
  const docs = new Map<string, any>()
  for (let i = 0; i < 12000; i++) {
    const embedding = new Float32Array(256)
    // Repeated scores exercise stable ties, while positive second dimensions
    // ensure these are real cosine computations, not a zero-vector shortcut.
    embedding[0] = 1; embedding[1] = (i % 97) / 97
    docs.set(String(i), { id: String(i), embedding, metadata: { recordingId: String(i), chunkIndex: 0,
      embedProvider: 'gemini-api', sourceType: i % 3 === 0 ? 'image' : 'transcript', captureId: `capture-${i % 5}` } })
  }
  ;(store as any).documents = docs
  const hydrate = vi.spyOn(store, 'hydrateContent').mockImplementation((rows: any) => rows)
  return { store, docs, hydrate }
}

function reference(docs: Map<string, any>, k: number) {
  const candidates = [...docs.values()].map(document => ({ document, score: 1 / Math.sqrt(1 + document.embedding[1] ** 2) }))
    .sort((a,b) => b.score-a.score).slice(0, Math.max(20, k*4))
  const selected: typeof candidates = [], skipped: typeof candidates = [], counts = new Map<string,number>()
  let images=0
  for(const r of candidates){
    if(selected.length>=k) break
    if(r.document.metadata.sourceType==='image'){
      const key=r.document.metadata.captureId, count=counts.get(key)||0
      if(images>=Math.max(1,k-Math.ceil(k/2))||count>=2){skipped.push(r);continue}
      counts.set(key,count+1);images++
    }
    selected.push(r)
  }
  return selected.concat(skipped.slice(0,k-selected.length)).map(r=>r.document.id)
}
beforeEach(()=>{state.provider='gemini-api';state.excluded.clear();state.pages=[]})
describe('yielding semantic scoring',()=>{
  it('advances timers over 12000 vectors while preserving stable scores and diversity',async()=>{
    const {store,docs}=corpus();let ticks=0
    const timer=setInterval(()=>ticks++,0)
    try{
      const results=await store.search('cached deterministic query',7)
      expect(ticks).toBeGreaterThan(2)
      expect(results.map(r=>r.document.id)).toEqual(reference(docs,7))
      expect(Math.max(...state.pages)).toBeLessThanOrEqual(128)
    }finally{clearInterval(timer)}
  })
  it('rechecks exclusions committed during yielding before hydrating',async()=>{
    const {store,hydrate}=corpus()
    setTimeout(()=>state.excluded.add('0'),0)
    const results=await store.search('query',7)
    expect(results.some(r=>r.document.id==='0')).toBe(false)
    expect(hydrate.mock.calls[0][0].some(r=>r.id==='0')).toBe(false)
  })
  it.each(['provider','corpus'])('refuses a changed %s without hydrating or retrying',async change=>{
    const {store,hydrate}=corpus()
    setTimeout(()=>{if(change==='provider')state.provider='ollama';else (store as any).corpusRevision++},0)
    expect(await store.search('query',7)).toEqual([])
    expect(hydrate).not.toHaveBeenCalled()
  })
  it('preserves empty topK=0 results',async()=>{
    const {store}=corpus()
    expect(await store.search('query',0)).toEqual([])
  })
})
