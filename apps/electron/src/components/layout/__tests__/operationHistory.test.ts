import { describe, it, expect } from 'vitest'
import { countActiveDownloads, isEarlierFailure, mergeDownloadQueues, splitBySession } from '../operationHistory'

describe('operationHistory', () => {
  it('puts only failures from an earlier session in the earlier group', () => {
    const items = [
      { id: 'old-fail', status: 'failed', fromPreviousSession: true },
      { id: 'new-fail', status: 'failed', fromPreviousSession: false },
      { id: 'queued', status: 'pending' },
      // A user cancel from an earlier session is the marker that stops the
      // file being queued again; a one-click Clear must never remove it.
      { id: 'old-cancel', status: 'cancelled', fromPreviousSession: true }
    ]

    const { current, earlier } = splitBySession(items)

    expect(earlier.map((i) => i.id)).toEqual(['old-fail'])
    expect(current.map((i) => i.id)).toEqual(['new-fail', 'queued', 'old-cancel'])
  })

  it('never treats queued or running work as earlier, even if the flag is set', () => {
    expect(isEarlierFailure({ status: 'pending', fromPreviousSession: true })).toBe(false)
    expect(isEarlierFailure({ status: 'downloading', fromPreviousSession: true })).toBe(false)
  })

  it('lets a terminal main-queue tombstone override a stale renderer active row', () => {
    const merged = mergeDownloadQueues(
      [{ filename: 'REC0001.WAV', progress: 80, size: 1000, status: 'downloading' }],
      [{ filename: 'REC0001.WAV', progress: 80, size: 1000, status: 'cancelled', cancelReason: 'user' }]
    )

    expect(merged[0]).toMatchObject({ status: 'cancelled', cancelReason: 'user' })
    expect(countActiveDownloads(merged)).toBe(0)
  })

  it('drops renderer-only rows once an authoritative main snapshot is available', () => {
    const merged = mergeDownloadQueues(
      [{ filename: 'STALE.WAV', progress: 80, size: 1000, status: 'downloading' }],
      [{ filename: 'REC0001.WAV', progress: 80, size: 1000, status: 'cancelled' }]
    )

    expect(merged.map((item) => item.filename)).toEqual(['REC0001.WAV'])
    expect(countActiveDownloads(merged)).toBe(0)
  })

  it('keeps optimistic renderer rows before the first main snapshot', () => {
    const merged = mergeDownloadQueues(
      [{ filename: 'REC0001.WAV', progress: 5, size: 1000, status: 'downloading' }],
      [],
      false
    )

    expect(countActiveDownloads(merged)).toBe(1)
  })

  it('counts only queue rows with active statuses, not a session-level active marker', () => {
    const queue = [
      { status: 'pending' },
      { status: 'downloading' },
      { status: 'cancelling' },
      { status: 'cancelled' },
      { status: 'failed' },
      { status: 'completed' }
    ] as const

    expect(countActiveDownloads(queue)).toBe(3)
  })

  it('keeps faster renderer progress when both queue snapshots agree it is downloading', () => {
    const merged = mergeDownloadQueues(
      [{ filename: 'REC0001.WAV', progress: 80, size: 1000, status: 'downloading' }],
      [{ filename: 'REC0001.WAV', progress: 60, size: 1000, status: 'downloading' }]
    )

    expect(merged[0].progress).toBe(80)
  })
})
