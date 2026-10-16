import { describe, expect, it, vi } from 'vitest'
import { queueAudioWork } from '../audioWorkQueue'
describe('whole audio operation admission', () => {
  it('keeps a cancelled native decode in its slot and skips stale queued reads', async () => {
    let finish!: () => void
    const native = new Promise<void>(resolve => { finish = resolve })
    const readA = vi.fn(() => native)
    const readB = vi.fn(async () => {})
    const readC = vi.fn(async () => {})
    let stale = false
    const a = queueAudioWork(readA, () => false)
    const b = queueAudioWork(readB, () => stale)
    const c = queueAudioWork(readC, () => false)
    await Promise.resolve(); await Promise.resolve()
    expect(readA).toHaveBeenCalledOnce()
    stale = true
    expect(readB).not.toHaveBeenCalled()
    expect(readC).not.toHaveBeenCalled()
    finish(); await Promise.all([a,b,c])
    expect(readB).not.toHaveBeenCalled()
    expect(readC).toHaveBeenCalledOnce()
  })
  it('a failed decode does not block future admitted playback', async () => {
    await expect(queueAudioWork(async () => { throw new Error('decoder failed') }, () => false)).rejects.toThrow('decoder failed')
    const next = vi.fn(async () => {})
    await queueAudioWork(next, () => false)
    expect(next).toHaveBeenCalledOnce()
  })
})
