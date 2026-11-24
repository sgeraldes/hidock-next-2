// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { backendTrayState, DEFAULT_RESOURCE_LIMITS, OwnedResourceSampler, SustainedResourceAlert, type ResourceReading } from '../backend-resources'
const reading = (cpuPercent: number | null, ramMb: number | null = 100, ramPercent: number | null = 1, cpuPartial = false): ResourceReading => ({ cpuPercent, ramMb, ramPercent, cpuPartial, processCount: 1 })
describe('own-process resource accounting', () => {
  it('normalizes cumulative CPU by all cores and calculates working-set capacity share', () => {
    const sampler = new OwnedResourceSampler()
    expect(sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 0, rssKb: 262144 }], 1000, 4, 1073741824).cpuPercent).toBeNull()
    const result = sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 2, rssKb: 262144 }], 3000, 4, 1073741824)
    expect(result.cpuPercent).toBe(25)
    expect(result.ramMb).toBe(256)
    expect(result.ramPercent).toBe(25)
    expect(result.cpuPartial).toBe(false)
  })
  it('reports empty samples as unknown, including an empty sample after valid counters', () => {
    const sampler = new OwnedResourceSampler()
    const expected = { cpuPercent: null, ramMb: null, ramPercent: null, cpuPartial: true, processCount: 0 }
    expect(sampler.sample([], 1000, 4, 1073741824)).toEqual(expected)
    sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 0, rssKb: 262144 }], 2000, 4, 1073741824)
    expect(sampler.sample([], 3000, 4, 1073741824)).toEqual(expected)
  })
  it('does not turn invalid RSS into zero and preserves explicitly partial CPU', () => {
    const sampler = new OwnedResourceSampler()
    sampler.sample([
      { pid: 1, creationTime: 1, cpuSeconds: 0, rssKb: 100 },
      { pid: 2, creationTime: 2, cpuSeconds: 0, rssKb: 100 },
    ], 1000, 4, 1073741824)
    const result = sampler.sample([
      { pid: 1, creationTime: 1, cpuSeconds: 2, rssKb: Number.NaN },
      { pid: 2, creationTime: 2, cpuSeconds: 2, rssKb: 100 },
      { pid: 3, creationTime: 3, rssKb: -1 },
    ], 3000, 4, 1073741824)
    expect(result.cpuPercent).toBe(50)
    expect(result.cpuPartial).toBe(true)
    expect(result.ramMb).toBeNull()
    expect(result.ramPercent).toBeNull()
    const cpuUnavailable = sampler.sample([
      { pid: 1, creationTime: 1, cpuSeconds: Number.POSITIVE_INFINITY, rssKb: 100 },
    ], 4000, 4, 1073741824)
    expect(cpuUnavailable.cpuPercent).toBeNull()
    expect(cpuUnavailable.cpuPartial).toBe(true)
  })
  it('keeps working-set RAM while physical capacity is unknown', () => {
    for (const physicalBytes of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sampler = new OwnedResourceSampler()
      sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 0, rssKb: 262144 }], 1000, 4, physicalBytes)
      const result = sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 2, rssKb: 262144 }], 3000, 4, physicalBytes)
      expect(result.ramMb).toBe(256)
      expect(result.ramPercent).toBeNull()
    }
  })
  it('does not attribute reused PIDs or missing counters as complete CPU measurement', () => {
    const sampler = new OwnedResourceSampler()
    sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 100, rssKb: 1 }], 1000, 4, 1000000)
    const result = sampler.sample([{ pid: 1, creationTime: 2, cpuSeconds: 500, rssKb: 1 }, { pid: 2, creationTime: 2, rssKb: 1 }], 2000, 4, 1000000)
    expect(result.cpuPercent).toBeNull()
    expect(result.cpuPartial).toBe(true)
  })
  it('reports null when a missing counter returns without a baseline, then measures again', () => {
    const sampler = new OwnedResourceSampler()
    sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 10, rssKb: 1024 }], 1000, 4, 1073741824)
    const missing = sampler.sample([{ pid: 1, creationTime: 1, rssKb: 1024 }], 2000, 4, 1073741824)
    expect(missing.cpuPercent).toBeNull()
    expect(missing.cpuPartial).toBe(true)
    const returned = sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 12, rssKb: 1024 }], 3000, 4, 1073741824)
    expect(returned.cpuPercent).toBeNull()
    expect(returned.cpuPartial).toBe(true)
    const measured = sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 14, rssKb: 1024 }], 5000, 4, 1073741824)
    expect(measured.cpuPercent).toBe(25)
    expect(measured.cpuPartial).toBe(false)
  })
  it('reports null when the only process reuses a pid with a new creation time', () => {
    const sampler = new OwnedResourceSampler()
    sampler.sample([{ pid: 7, creationTime: 1, cpuSeconds: 100, rssKb: 1 }], 1000, 4, 1000000)
    const reused = sampler.sample([{ pid: 7, creationTime: 2, cpuSeconds: 500, rssKb: 1 }], 2000, 4, 1000000)
    expect(reused.cpuPercent).toBeNull()
    expect(reused.cpuPartial).toBe(true)
  })
  it('keeps a genuine 0 when the comparable delta is zero', () => {
    const sampler = new OwnedResourceSampler()
    sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 5, rssKb: 1 }], 1000, 4, 1000000)
    const idle = sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 5, rssKb: 1 }], 2000, 4, 1000000)
    expect(idle.cpuPercent).toBe(0)
    expect(idle.cpuPartial).toBe(false)
  })
  it('measures only the comparable processes in a partial mix and flags it partial', () => {
    const sampler = new OwnedResourceSampler()
    sampler.sample([
      { pid: 1, creationTime: 1, cpuSeconds: 0, rssKb: 1 },
      { pid: 2, creationTime: 1, cpuSeconds: 0, rssKb: 1 },
    ], 1000, 4, 1000000)
    const mixed = sampler.sample([
      { pid: 1, creationTime: 1, cpuSeconds: 2, rssKb: 1 },
      { pid: 2, creationTime: 9, cpuSeconds: 900, rssKb: 1 },
      { pid: 3, creationTime: 1, rssKb: 1 },
      { pid: 4, creationTime: 1, cpuSeconds: 3, rssKb: 1 },
    ], 3000, 4, 1000000)
    expect(mixed.cpuPercent).toBe(25)
    expect(mixed.cpuPartial).toBe(true)
    expect(mixed.processCount).toBe(4)
  })
  it('reports a comparable zero delta as 0 while another process has no baseline', () => {
    const sampler = new OwnedResourceSampler()
    sampler.sample([{ pid: 1, creationTime: 1, cpuSeconds: 5, rssKb: 1 }], 1000, 4, 1000000)
    const mixed = sampler.sample([
      { pid: 1, creationTime: 1, cpuSeconds: 5, rssKb: 1 },
      { pid: 2, creationTime: 1, cpuSeconds: 50, rssKb: 1 },
    ], 2000, 4, 1000000)
    expect(mixed.cpuPercent).toBe(0)
    expect(mixed.cpuPartial).toBe(true)
  })
})
describe('sustained limits and accessible priorities', () => {
  it('waits for sustained excess, applies hysteresis and respects cooldown', () => {
    const detector = new SustainedResourceAlert()
    const limits = { ...DEFAULT_RESOURCE_LIMITS, sustainedMs: 10000, cooldownMs: 60000 }
    expect(detector.evaluate(reading(80), limits, 0)).toEqual({ high: false, notify: false })
    expect(detector.evaluate(reading(80), limits, 9999)).toEqual({ high: false, notify: false })
    expect(detector.evaluate(reading(80), limits, 10000)).toEqual({ high: true, notify: true })
    expect(detector.evaluate(reading(66), limits, 20000)).toEqual({ high: true, notify: false })
    expect(detector.evaluate(reading(60), limits, 21000)).toEqual({ high: false, notify: false })
    detector.evaluate(reading(80), limits, 30000)
    expect(detector.evaluate(reading(80), limits, 40000)).toEqual({ high: true, notify: false })
    expect(detector.evaluate(reading(80), limits, 70000)).toEqual({ high: true, notify: true })
  })
  it('does not clear an active alert on unknown or partial readings', () => {
    const detector = new SustainedResourceAlert()
    const limits = { ...DEFAULT_RESOURCE_LIMITS, sustainedMs: 10000, cooldownMs: 60000 }
    expect(detector.evaluate(reading(80), limits, 0)).toEqual({ high: false, notify: false })
    expect(detector.evaluate(reading(80), limits, 10000)).toEqual({ high: true, notify: true })
    expect(detector.evaluate(reading(null, null, null, true), limits, 11000)).toEqual({ high: true, notify: false })
    expect(detector.evaluate(reading(0, 100, 1, true), limits, 12000)).toEqual({ high: true, notify: false })
    expect(detector.evaluate(reading(0, 100, null), limits, 12500)).toEqual({ high: true, notify: false })
    expect(detector.evaluate(reading(0), limits, 13000)).toEqual({ high: false, notify: false })
  })
  it('does not start a high alert from unknown readings alone', () => {
    const detector = new SustainedResourceAlert()
    const limits = { ...DEFAULT_RESOURCE_LIMITS, sustainedMs: 5000 }
    expect(detector.evaluate(reading(null, null, null, true), limits, 0)).toEqual({ high: false, notify: false })
    expect(detector.evaluate(reading(null, null, null, true), limits, 5000)).toEqual({ high: false, notify: false })
  })
  it('recognizes either RAM threshold and preserves status priorities without colour alone', () => {
    const detector = new SustainedResourceAlert()
    detector.evaluate(reading(1, 2100), DEFAULT_RESOURCE_LIMITS, 0)
    expect(detector.evaluate(reading(1, 2100), DEFAULT_RESOURCE_LIMITS, 15000).high).toBe(true)
    expect(backendTrayState(false, 0, false, false)).toBe('free')
    expect(backendTrayState(false, 1, false, false)).toBe('working')
    expect(backendTrayState(true, 1, false, false)).toBe('paused')
    expect(backendTrayState(true, 1, true, false)).toBe('high-usage')
    expect(backendTrayState(true, 1, true, true)).toBe('waiting')
  })
})
