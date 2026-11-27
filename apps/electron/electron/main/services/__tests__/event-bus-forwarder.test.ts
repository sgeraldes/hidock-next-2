// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getEventBus } from '../event-bus'

describe('event bus forwarder (database process)', () => {
  it('forwards every event and reports a listener while it forwards', () => {
    const bus = getEventBus()
    const forwarded: string[] = []
    expect(bus.listenerCount('test:forward')).toBe(0)
    bus.setForwarder((event) => { forwarded.push(event.type) })
    try {
      expect(bus.listenerCount('test:forward')).toBe(1)
      bus.emitDomainEvent({ type: 'test:forward', timestamp: '', payload: {} } as never)
      expect(forwarded).toEqual(['test:forward'])
    } finally {
      bus.setForwarder(null)
    }
    expect(bus.listenerCount('test:forward')).toBe(0)
  })

  it('keeps emitting when the forwarder throws', () => {
    const bus = getEventBus()
    const local: string[] = []
    const stop = bus.onDomainEvent('test:throws', (event) => { local.push(event.type) })
    bus.setForwarder(() => { throw new Error('port closed') })
    try {
      expect(() => bus.emitDomainEvent({ type: 'test:throws', timestamp: '', payload: {} } as never)).not.toThrow()
    } finally {
      bus.setForwarder(null)
      stop()
    }
    expect(local).toEqual(['test:throws'])
  })
})
