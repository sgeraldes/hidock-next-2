/** @vitest-environment node */
import { expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const deps = vi.hoisted(() => ({ yield: vi.fn(async () => {}) }))
vi.mock('../event-loop', () => ({ yieldToEventLoop: deps.yield }))
import {
  readVectorCache,
  readVectorCacheAsync,
  writeVectorCache
} from '../vector-cache'
it('yields for every 1024 IDs and vectors, including tails, without changing decoded rows', async () => {
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
  expect(deps.yield).toHaveBeenCalledTimes(6)
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
  deps.yield.mockClear()
  expect(await readVectorCacheAsync(file, 'ollama', 2)).toBeNull()
  expect(deps.yield).not.toHaveBeenCalled()
})
