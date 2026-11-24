import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../useAppStore'
import type { Meeting } from '@/types'

const meeting = (id: string) => ({ id, subject: id, start_time: '2026-10-06T10:00:00Z', end_time: '2026-10-06T11:00:00Z' }) as Meeting
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const getAll = vi.fn()
const sync = vi.fn()
beforeEach(() => {
  useAppStore.getState().setMeetings([])
  useAppStore.setState({ meetingsLoading: false, calendarSyncActiveCount: 0, calendarSyncing: false, calendarSyncError: null })
  getAll.mockReset(); sync.mockReset()
  Object.assign(window, { electronAPI: { meetings: { getAll }, calendar: { sync } } })
})

describe('calendar cache-first', () => {
  it('keeps saved meetings and freshness throughout a slow/offline sync', async () => {
    const pending = deferred<any>()
    useAppStore.getState().setMeetings([meeting('saved')])
    useAppStore.getState().setLastCalendarSync('2026-10-05T12:00:00Z')
    sync.mockReturnValue(pending.promise)
    const request = useAppStore.getState().syncCalendar()
    expect(useAppStore.getState().meetings[0].id).toBe('saved')
    expect(useAppStore.getState().calendarSyncing).toBe(true)
    pending.resolve({ success: false, meetingsCount: 0, errorCategory: 'network' })
    await request
    expect(useAppStore.getState().meetings[0].id).toBe('saved')
    expect(useAppStore.getState().lastCalendarSync).toBe('2026-10-05T12:00:00Z')
    expect(useAppStore.getState().calendarSyncError).toContain('Saved events')
    expect(getAll).not.toHaveBeenCalled()
  })

  it('joins duplicate mounts and ignores an older range response', async () => {
    const old = deferred<Meeting[]>(), latest = deferred<Meeting[]>()
    getAll.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    const first = useAppStore.getState().loadMeetings('2026-10-05Z', '2026-10-12Z')
    const duplicate = useAppStore.getState().loadMeetings('2026-10-05Z', '2026-10-12Z')
    expect(getAll).toHaveBeenCalledTimes(1)
    const next = useAppStore.getState().loadMeetings('2026-10-12Z', '2026-10-19Z')
    latest.resolve([meeting('latest')]); await next
    old.resolve([meeting('old')]); await Promise.all([first, duplicate])
    expect(useAppStore.getState().meetings.map(m => m.id)).toEqual(['latest'])
    expect(useAppStore.getState().meetingsLoading).toBe(false)
  })

  it('a sync completion bypasses a stale in-flight DB read', async () => {
    const old = deferred<Meeting[]>(), fresh = deferred<Meeting[]>()
    getAll.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const first = useAppStore.getState().loadMeetings('2026-10-05Z', '2026-10-12Z')
    const next = useAppStore.getState().loadMeetings('2026-10-05Z', '2026-10-12Z', { refresh: true })
    fresh.resolve([meeting('updated')]); await next
    old.resolve([meeting('deleted')]); await first
    expect(useAppStore.getState().meetings.map(m => m.id)).toEqual(['updated'])
  })
})
