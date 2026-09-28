// @vitest-environment node

/**
 * Library maintenance jobs: coarse waveforms from the stored envelope, and
 * relinking recordings to meetings through the Microsoft 365 calendar history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  unlinked: [925, 700],
  oldest: '2025-05-12T14:41:41.000Z' as string | null,
  profiles: [] as Array<{ id: string; file_path: string | null; duration_seconds: number | null }>
}

vi.mock('../database', () => ({
  queryAll: vi.fn(() => state.profiles),
  queryOne: vi.fn((sql: string) => {
    if (/MIN\(date_recorded\)/.test(sql)) return { first: state.oldest }
    if (/meeting_id IS NULL/.test(sql)) return { n: state.unlinked.shift() ?? 0 }
    return { n: 0 }
  }),
  run: vi.fn()
}))

const files = new Map<string, Uint8Array>()
vi.mock('fs/promises', () => ({
  readFile: async (p: string) => {
    if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return Buffer.from(files.get(p)!)
  },
  stat: async (p: string) => {
    if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { size: 1234 }
  }
}))

vi.mock('../audio-profile-store', () => ({ envelopePath: (id: string) => `env/${id}.u8` }))

const cache = new Map<string, { coarse?: boolean }>()
const setWaveformCache = vi.fn((id: string, _peaks: number[], _d: number, _s: number, coarse?: boolean) => {
  cache.set(id, { coarse })
  return true
})
vi.mock('../waveform-cache', () => ({
  getWaveformCache: (id: string) => cache.get(id) ?? null,
  setWaveformCache: (...args: Parameters<typeof setWaveformCache>) => setWaveformCache(...args)
}))

vi.mock('../value-classification', () => ({ recomputeAudioWarnings: vi.fn(async () => 3) }))

const syncNow = vi.fn(async () => ({ meetings: 1200, contacts: 0, artifacts: 0, skipped: 0 }))
const setConfig = vi.fn()
const setSourceState = vi.fn()
vi.mock('../connectors', () => ({
  getConnectorHost: () => ({
    listInstances: () => ['m365', 'slack'],
    summary: (id: string) => ({
      label: id === 'm365' ? 'Microsoft 365' : 'Slack',
      descriptor: { id },
      status: { state: 'connected' }
    }),
    syncNow
  })
}))
vi.mock('../connectors/connector-store', () => ({ getConnectorStore: () => ({ setConfig, setSourceState }) }))

const autoLink = vi.fn(() => 225)
vi.mock('../org-reconciler', () => ({ autoLinkRecordingsToMeetings: () => autoLink() }))

import { peaksFromEnvelope, redrawWaveforms, relinkRecordingsToMeetings, GAIN_AMPLITUDE_OFFSET } from '../library-maintenance'

beforeEach(() => {
  state.unlinked = [925, 700]
  state.oldest = '2025-05-12T14:41:41.000Z'
  files.clear()
  cache.clear()
  vi.clearAllMocks()
})

describe('peaksFromEnvelope', () => {
  it('turns frame gains into amplitudes, loudest frame per bucket', () => {
    const env = new Uint8Array([0, 0, GAIN_AMPLITUDE_OFFSET, GAIN_AMPLITUDE_OFFSET - 4, 0, 255])
    const peaks = peaksFromEnvelope(env, 3)
    expect(peaks).toHaveLength(3)
    expect(peaks[0]).toBe(0) // silence stays flat
    expect(peaks[1]).toBeCloseTo(1) // at the offset: full scale
    expect(peaks[2]).toBe(1) // louder than the offset is clamped
    expect(peaksFromEnvelope(new Uint8Array([GAIN_AMPLITUDE_OFFSET - 4]), 1)[0]).toBeCloseTo(0.5) // 4 steps = half
  })

  it('never returns more peaks than frames, and nothing for an empty envelope', () => {
    expect(peaksFromEnvelope(new Uint8Array([200, 200]), 1000)).toHaveLength(2)
    expect(peaksFromEnvelope(new Uint8Array(), 1000)).toEqual([])
  })
})

describe('redrawWaveforms', () => {
  it('draws coarse waveforms, keeps exact ones, and counts recordings with no envelope', async () => {
    state.profiles = [
      { id: 'r-new', file_path: 'a.wav', duration_seconds: 60 },
      { id: 'r-exact', file_path: 'b.wav', duration_seconds: 60 },
      { id: 'r-old-coarse', file_path: null, duration_seconds: 60 },
      { id: 'r-no-env', file_path: null, duration_seconds: 60 }
    ]
    files.set('a.wav', new Uint8Array())
    files.set('env/r-new.u8', new Uint8Array(3000).fill(180))
    files.set('env/r-exact.u8', new Uint8Array(3000).fill(180))
    files.set('env/r-old-coarse.u8', new Uint8Array(3000).fill(180))
    cache.set('r-exact', {})
    cache.set('r-old-coarse', { coarse: true })

    const result = await redrawWaveforms()

    expect(result).toEqual({ total: 4, drawn: 2, keptExact: 1, noEnvelope: 1 })
    const drawn = setWaveformCache.mock.calls.map((c) => c[0])
    expect(drawn).toEqual(['r-new', 'r-old-coarse'])
    expect(setWaveformCache.mock.calls[0][1]).toHaveLength(1000)
    expect(setWaveformCache.mock.calls[0][4]).toBe(true) // marked coarse
  })
})

describe('relinkRecordingsToMeetings', () => {
  it('pulls the Microsoft 365 calendar from the oldest recording with a fresh cursor, then links', async () => {
    const result = await relinkRecordingsToMeetings()

    expect(setConfig).toHaveBeenCalledWith('m365', { calendarHistoryStart: '2025-05-11T14:41:41.000Z' })
    expect(setSourceState).toHaveBeenCalledWith('m365', 'calendar', { cursor: null })
    expect(syncNow).toHaveBeenCalledTimes(1) // Slack is not a calendar
    expect(syncNow).toHaveBeenCalledWith('m365', 'calendar')
    expect(result).toMatchObject({ unlinkedBefore: 925, unlinkedAfter: 700, linked: 225, meetingsSynced: 1200, accounts: 1, errors: [] })
  })

  it('keeps syncing while the calendar sync stops at the page cap', async () => {
    syncNow
      .mockResolvedValueOnce({ meetings: 500, contacts: 0, artifacts: 0, skipped: 0, truncated: true } as never)
      .mockResolvedValueOnce({ meetings: 500, contacts: 0, artifacts: 0, skipped: 0, truncated: true } as never)
      .mockResolvedValueOnce({ meetings: 200, contacts: 0, artifacts: 0, skipped: 0 })
    const result = await relinkRecordingsToMeetings()
    expect(syncNow).toHaveBeenCalledTimes(3)
    expect(result.meetingsSynced).toBe(1200)
    expect(autoLink).toHaveBeenCalledTimes(1)
  })

  it('still links with the meetings already here when the calendar pull fails', async () => {
    syncNow.mockRejectedValueOnce(new Error('Graph GET 401'))
    const result = await relinkRecordingsToMeetings()
    expect(result.errors).toEqual(['Microsoft 365: Graph GET 401'])
    expect(autoLink).toHaveBeenCalledTimes(1)
  })
})
