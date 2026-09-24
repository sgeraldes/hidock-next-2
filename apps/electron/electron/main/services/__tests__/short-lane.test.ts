/**
 * The short-recording lane: which waiting recording may run beside a long job.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' }, ipcMain: { handle: vi.fn() } }))

const { pickShortLaneItem, estimateTranscriptionSeconds, SHORT_LANE_MIN_GAIN_SECONDS } = await import('../transcription')

describe('estimateTranscriptionSeconds', () => {
  it('grows with the recording and with a local voice step', () => {
    const hour = 3600
    expect(estimateTranscriptionSeconds(hour, false)).toBeLessThan(estimateTranscriptionSeconds(hour, true))
    expect(estimateTranscriptionSeconds(4 * hour, false)).toBeGreaterThan(estimateTranscriptionSeconds(hour, false))
  })

  it('treats an unknown length as an hour, never as zero', () => {
    expect(estimateTranscriptionSeconds(null, false)).toBe(estimateTranscriptionSeconds(3600, false))
    expect(estimateTranscriptionSeconds(0, true)).toBe(estimateTranscriptionSeconds(3600, true))
  })
})

describe('pickShortLaneItem', () => {
  const est = (i: { seconds: number }) => i.seconds

  it('runs the 24-sep case: a 37-minute meeting beside a 4-hour backlog item that just started', () => {
    const meeting = { id: 'Rec56', seconds: estimateTranscriptionSeconds(2220, false) }
    const remaining = estimateTranscriptionSeconds(14398, false)
    expect(pickShortLaneItem([meeting], remaining, est)).toBe(meeting)
  })

  it('takes the first waiting item, in processing order, that finishes well before the running job', () => {
    const long = { id: 'long', seconds: 2000 }
    const short = { id: 'short', seconds: 100 }
    const shorter = { id: 'shorter', seconds: 50 }
    expect(pickShortLaneItem([long, short, shorter], 1500, est)).toBe(short)
  })

  it('waits when nothing would gain at least the minimum', () => {
    const a = { id: 'a', seconds: 400 }
    expect(pickShortLaneItem([a], 400 + SHORT_LANE_MIN_GAIN_SECONDS, est)).toBeNull()
    expect(pickShortLaneItem([a], 400 + SHORT_LANE_MIN_GAIN_SECONDS + 1, est)).toBe(a)
  })

  it('never starts once the running job is nearly done', () => {
    expect(pickShortLaneItem([{ id: 'x', seconds: 5 }], 0, est)).toBeNull()
    expect(pickShortLaneItem([{ id: 'x', seconds: 5 }], -30, est)).toBeNull()
  })
})
