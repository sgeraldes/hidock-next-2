// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { beginDeviceSnapshot, currentDeviceSession, deviceListGuard, invalidateDeviceSnapshots, isCompleteDeviceSnapshot, rememberDeviceSnapshot } from '../device-snapshot'

describe('connected device snapshot authority', () => {
  it('rejects stale cached presence after a confirmed device deletion', () => {
    const old = beginDeviceSnapshot(() => true)
    rememberDeviceSnapshot(old, ['one.hda'])
    const cached = deviceListGuard(['one.hda'], () => true)
    expect(cached.isCurrent()).toBe(true)
    const empty = beginDeviceSnapshot(() => true)
    rememberDeviceSnapshot(empty, [])
    expect(cached.isCurrent()).toBe(false)
    expect(deviceListGuard(['one.hda'], () => true).isCurrent()).toBe(false)
    expect(deviceListGuard([], () => true).complete).toBe(false)
  })
  it('accepts a successful empty snapshot and rejects unknown, partial and duplicate lists', () => {
    expect(isCompleteDeviceSnapshot([], 0, 0)).toBe(true)
    expect(isCompleteDeviceSnapshot(null, 0, 0)).toBe(false)
    expect(isCompleteDeviceSnapshot([], undefined, 0)).toBe(false)
    expect(isCompleteDeviceSnapshot([], 1, 1)).toBe(false)
    expect(isCompleteDeviceSnapshot(['one'], 1, 2)).toBe(false)
    expect(isCompleteDeviceSnapshot(['one', 'ONE'], 2, 2)).toBe(false)
  })
  it('invalidates an older scan, disconnected scan and reconnected session', () => {
    let connected = true
    const first = beginDeviceSnapshot(() => connected)
    const second = beginDeviceSnapshot(() => connected)
    expect(first.isCurrent()).toBe(false)
    expect(second.isCurrent()).toBe(true)
    connected = false
    expect(second.isCurrent()).toBe(false)
    invalidateDeviceSnapshots()
    connected = true
    expect(second.isCurrent()).toBe(false)
    expect(currentDeviceSession(() => connected).complete).toBe(false)
  })
})
