/**
 * One local voice job at a time: the short-recording lane must never put a second
 * pyannote/ONNX worker beside the main lane's (review of #42).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../database', () => ({
  queryAll: vi.fn(() => []),
  queryOne: vi.fn(),
  runInTransaction: vi.fn((fn: () => unknown) => fn()),
  runNoSave: vi.fn()
}))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {} }), getDataPath: () => '', updateConfig: vi.fn() }))

import { inVoiceSlot } from '../speaker-linking'

describe('inVoiceSlot', () => {
  it('runs voice jobs one after another, never together', async () => {
    let running = 0
    let most = 0
    const order: string[] = []
    const job = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        running += 1
        most = Math.max(most, running)
        order.push(`start ${name}`)
        setTimeout(() => {
          running -= 1
          order.push(`end ${name}`)
          resolve(name)
        }, ms)
      })
    const results = await Promise.all([inVoiceSlot(job('main', 30)), inVoiceSlot(job('short', 5))])
    expect(results).toEqual(['main', 'short'])
    expect(most).toBe(1)
    expect(order).toEqual(['start main', 'end main', 'start short', 'end short'])
  })

  it('keeps going after a job fails', async () => {
    const failed = inVoiceSlot(() => Promise.reject(new Error('worker died')))
    await expect(failed).rejects.toThrow('worker died')
    await expect(inVoiceSlot(() => Promise.resolve('next'))).resolves.toBe('next')
  })
})
