/** @vitest-environment node */
import { expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createVectorWorkBudget,
  readVectorCache,
  readVectorCacheAsync,
  writeVectorCache
} from '../vector-cache'
it('preserves decoded rows with budgeted ID and vector pages', async () => {
  const file = join(
    mkdtempSync(join(tmpdir(), 'restore-codec-')),
    'vectors.bin'
  )
  const docs = Array.from({ length: 2050 }, (_, i) => ({
    id: String(i),
    provider: 'ollama',
    dims: 2,
    embedding: [i, -i]
  }))
  writeVectorCache(file, docs)
  const expected = readVectorCache(file)!
  const actual = await readVectorCacheAsync(file)
  expect(actual!.rows).toEqual(expected.rows)
  expect(actual!.groups).toEqual(expected.groups)
  expect(actual!.fingerprint).toBe(expected.fingerprint)
})
it('rejects a count-mismatched cache before decoding its ID or matrix sections', async () => {
  const file = join(
    mkdtempSync(join(tmpdir(), 'restore-codec-count-')),
    'vectors.bin'
  )
  writeVectorCache(file, [
    { id: 'one', provider: 'ollama', dims: 2, embedding: [1, 0] }
  ])
  expect(await readVectorCacheAsync(file, 'ollama', 2)).toBeNull()
})

it('yields through the poll loop no later than eight cheap pages', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    const pause = createVectorWorkBudget()
    for(let i=0;i<7;i++) expect(pause()).toBeUndefined()
    let advanced = false
    setImmediate(()=>{advanced=true})
    await pause()
    expect(advanced).toBe(true)
  } finally { vi.restoreAllMocks() }
})
