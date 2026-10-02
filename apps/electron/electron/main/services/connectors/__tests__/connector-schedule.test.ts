/**
 * Connected connectors sync on the calendar interval (the host had a scheduler
 * nothing called, so Microsoft 365 only synced on a click).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const host = vi.hoisted(() => ({
  listInstances: vi.fn(() => ['m365:a', 'slack:b', 'm365:c']),
  getStatus: vi.fn((id: string) => ({ state: id === 'm365:c' ? 'auth-needed' : 'connected' })),
  syncNow: vi.fn(async (_id: string) => ({ meetings: 0, contacts: 0, artifacts: 0, skipped: 0 })),
  connect: vi.fn(async () => undefined),
  register: vi.fn()
}))
const cfg = vi.hoisted(() => ({
  value: {
    calendar: { syncEnabled: true, syncIntervalMinutes: 15 },
    features: { preset: 'full', flags: {} }
  } as Record<string, any>
}))

vi.mock('@hidock/connectors', () => ({
  ConnectorHost: class {
    constructor() {
      return host
    }
  }
}))
vi.mock('@hidock/connectors-slack', () => ({}))
vi.mock('../connector-store', () => ({ getConnectorStore: () => ({}) }))
vi.mock('../ingestion', () => ({ createIngestionSink: () => ({}) }))
vi.mock('../m365/m365-connector', () => ({ m365Descriptor: {}, createM365Connector: vi.fn() }))
vi.mock('../../config', () => ({ getConfig: () => cfg.value }))
const bus = vi.hoisted(() => ({ emitDomainEvent: vi.fn() }))
vi.mock('../../event-bus', () => ({ getEventBus: () => bus }))

import { startConnectorSchedule, stopConnectorSchedule, syncConnectedConnectors } from '../index'

beforeEach(() => {
  vi.useFakeTimers()
  host.syncNow.mockClear()
  host.syncNow.mockImplementation(async () => ({ meetings: 0, contacts: 0, artifacts: 0, skipped: 0 }))
  bus.emitDomainEvent.mockClear()
  cfg.value = { calendar: { syncEnabled: true, syncIntervalMinutes: 15 }, features: { preset: 'full', flags: {} } }
})

afterEach(() => {
  stopConnectorSchedule()
  vi.useRealTimers()
})

describe('connector schedule', () => {
  it('syncs only the connected connectors', async () => {
    await syncConnectedConnectors()
    expect(host.syncNow.mock.calls.map((c) => c[0])).toEqual(['m365:a', 'slack:b'])
  })

  it('announces calendar:synced once when a scheduled run brought meetings, so meeting links are checked again', async () => {
    host.syncNow.mockImplementation(async (id: string) => ({ meetings: id === 'm365:a' ? 42 : 0, contacts: 0, artifacts: 0, skipped: 0 }))
    await syncConnectedConnectors()
    expect(bus.emitDomainEvent).toHaveBeenCalledTimes(1)
    expect(bus.emitDomainEvent.mock.calls[0][0]).toMatchObject({ type: 'calendar:synced', payload: { meetingsCount: 42 } })
  })

  it('stays quiet when a scheduled run brought no meetings', async () => {
    await syncConnectedConnectors()
    expect(bus.emitDomainEvent).not.toHaveBeenCalled()
  })

  it('runs two minutes after start, then every sync interval', async () => {
    startConnectorSchedule()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(host.syncNow).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(host.syncNow).toHaveBeenCalledTimes(4)
  })

  it('does nothing with auto-sync off or the Calendar feature off', async () => {
    cfg.value.calendar.syncEnabled = false
    startConnectorSchedule()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await syncConnectedConnectors()
    cfg.value.calendar.syncEnabled = true
    cfg.value.features = { preset: 'custom', flags: { calendar: false } }
    await syncConnectedConnectors()
    expect(host.syncNow).not.toHaveBeenCalled()
  })
})
