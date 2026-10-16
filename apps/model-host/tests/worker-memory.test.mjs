import { describe, it, expect, vi } from 'vitest'
const counters = vi.hoisted(() => ({ total: 64 * 1024 ** 3, free: 0, mkdtemp: vi.fn() }))
vi.mock('os', async importOriginal => ({ ...(await importOriginal()), totalmem: () => counters.total, freemem: () => counters.free }))
vi.mock('fs/promises', async importOriginal => ({ ...(await importOriginal()), mkdtemp: counters.mkdtemp }))
import { AUDIO8_MEMORY_PROFILE, workerMemoryMb, runDiarization } from '../src/diarize.mjs'
const GiB = 1024 ** 3
describe('adaptive host worker memory admission', () => {
  it('preserves the ordinary 16GiB/25 percent/half-free limits', () => {
    expect(workerMemoryMb(undefined, 64 * GiB, 52 * GiB)).toBe(16384)
    expect(workerMemoryMb(undefined, 32 * GiB, 30 * GiB)).toBe(8192)
    expect(workerMemoryMb(undefined, 64 * GiB, 10 * GiB)).toBe(5120)
  })
  it('bounds Audio8 by 24GiB,37.5 percent of total and half-free', () => {
    expect(workerMemoryMb(AUDIO8_MEMORY_PROFILE, 64 * GiB, 52 * GiB)).toBe(24576)
    expect(workerMemoryMb(AUDIO8_MEMORY_PROFILE, 128 * GiB, 100 * GiB)).toBe(24576)
    expect(workerMemoryMb(AUDIO8_MEMORY_PROFILE, 64 * GiB, 42 * GiB)).toBe(21504)
    expect(workerMemoryMb(AUDIO8_MEMORY_PROFILE, 64 * GiB, 40 * GiB)).toBe(20480)
    expect(() => workerMemoryMb(AUDIO8_MEMORY_PROFILE, 32 * GiB, 30 * GiB)).toThrow(/at least 20 GiB/)
    expect(() => workerMemoryMb(AUDIO8_MEMORY_PROFILE, 64 * GiB, 39 * GiB)).toThrow(/at least 20 GiB/)
  })
  it('does not accept JSON/string lookalikes as a larger budget', () => {
    for (const profile of ['audio8-host-memory-profile', { memoryMb: 999999 }, 24576]) {
      expect(workerMemoryMb(profile, 64 * GiB, 52 * GiB)).toBe(16384)
    }
  })
  it('fails closed on invalid counters', () => {
    expect(() => workerMemoryMb(undefined, NaN, 100)).toThrow(/counters/)
    expect(() => workerMemoryMb(AUDIO8_MEMORY_PROFILE, 64 * GiB, -1)).toThrow(/counters/)
  })
})


describe('ordinary worker minimum cap', () => {
  it.each([28, 32, 64, 96, 128])('rejects unsafe free memory on a %i GiB host without relaxing the cap', totalGiB => {
    for (const freeBytes of [0, 1, 1024 ** 2, GiB, 2 * GiB - 1]) {
      expect(() => workerMemoryMb(undefined, totalGiB * GiB, freeBytes)).toThrow(/at least 1 GiB.*no fallback was started/)
    }
    expect(workerMemoryMb(undefined, totalGiB * GiB, 2 * GiB)).toBe(1024)
    for (const freeGiB of [2, 3, 8, totalGiB]) {
      const budget = workerMemoryMb(undefined, totalGiB * GiB, freeGiB * GiB)
      expect(budget).toBeGreaterThanOrEqual(1024)
      expect(budget * 1024 ** 2).toBeLessThanOrEqual(freeGiB * GiB / 2)
      expect(budget * 1024 ** 2).toBeLessThanOrEqual(totalGiB * GiB / 4)
      expect(budget).toBeLessThanOrEqual(16384)
    }
  })
  it('also rejects when total-memory share, rather than free memory, falls below minimum', () => {
    expect(() => workerMemoryMb(undefined, 4 * GiB - 1, 3 * GiB)).toThrow(/at least 1 GiB/)
    expect(workerMemoryMb(undefined, 4 * GiB, 3 * GiB)).toBe(1024)
  })
  it('refuses the real runner before temporary storage or spawn on zero/tiny free memory', async () => {
    const spawnFn = vi.fn()
    counters.mkdtemp.mockClear()
    for (const free of [0, 1, GiB, 2 * GiB - 1]) {
      counters.free = free
      await expect(runDiarization(Buffer.from('fixture'), { spawnFn })).rejects.toThrow(/at least 1 GiB/)
    }
    expect(counters.mkdtemp).not.toHaveBeenCalled()
    expect(spawnFn).not.toHaveBeenCalled()
  })
})
