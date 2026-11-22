// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { inProcessingRunScope, registerProcessingRun, releaseProcessingRun } from '../processing-run-scope'

it('settles unfinished stages after failure without touching a concurrent operation', async () => {
  const settled: string[] = []
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const other = inProcessingRunScope(async () => {
    registerProcessingRun('other')
    await pending
    releaseProcessingRun('other')
  }, id => { settled.push(id) })
  await expect(inProcessingRunScope(async () => {
    registerProcessingRun('root')
    registerProcessingRun('completed')
    releaseProcessingRun('completed')
    registerProcessingRun('stranded-child')
    throw new Error('database write failed')
  }, id => { settled.push(id) })).rejects.toThrow('database write failed')
  expect(settled).toEqual(['root', 'stranded-child'])
  release()
  await other
  expect(settled).toEqual(['root', 'stranded-child'])
})


it('attempts all settlements and preserves the original pipeline failure', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const settled: string[] = []
  const original = new Error('original pipeline failure')
  try {
    await expect(inProcessingRunScope(async () => {
      registerProcessingRun('first'); registerProcessingRun('second'); throw original
    }, id => { settled.push(id); throw new Error('disk unavailable') })).rejects.toBe(original)
    expect(settled).toEqual(['first', 'second'])
    expect(log).toHaveBeenCalledOnce()
  } finally { log.mockRestore() }
})

it('reports cleanup errors after successful work, after attempting all settlements', async () => {
  const settled: string[] = []
  await expect(inProcessingRunScope(async () => {
    registerProcessingRun('first'); registerProcessingRun('second'); return 'result'
  }, id => { settled.push(id); throw new Error('disk unavailable') })).rejects.toBeInstanceOf(AggregateError)
  expect(settled).toEqual(['first', 'second'])
})
