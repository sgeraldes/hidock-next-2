import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store/useAppStore'
import type { UnifiedRecording } from '@/types/unified-recording'
import { useEvaluationUpdates, EVALUATION_FLUSH_MS } from '../useEvaluationUpdates'

/**
 * The chips of a recording (stars, kind) appear when its evaluation is saved,
 * not only after the next full refresh (owner, 2-oct-2026: rows with a saved
 * evaluation showed no chip).
 */

type Listener = (event: { type?: string; payload?: unknown }) => void
let listener: Listener | null = null

const rec = (id: string): UnifiedRecording =>
  ({
    id,
    filename: `${id}.hda`,
    size: 1,
    duration: 60,
    dateRecorded: new Date('2026-10-02T14:00:00Z'),
    transcriptionStatus: 'complete',
    location: 'local-only',
    localPath: `/r/${id}.wav`,
    syncStatus: 'synced'
  }) as UnifiedRecording

beforeEach(() => {
  listener = null
  Object.defineProperty(window, 'electronAPI', {
    value: {
      onDomainEvent: (cb: Listener) => {
        listener = cb
        return () => {
          listener = null
        }
      }
    },
    writable: true,
    configurable: true
  })
  useAppStore.getState().setUnifiedRecordings([rec('r1'), rec('r2')])
})

describe('useEvaluationUpdates', () => {
  it('puts the saved evaluation on that recording only', () => {
    vi.useFakeTimers()
    renderHook(() => useEvaluationUpdates())
    act(() => {
      listener?.({
        type: 'evaluation:saved',
        payload: { recordingId: 'r1', starLevel: 5, kind: 'team_meeting', context: 'work', audioWarning: null, transcriptInvented: false }
      })
      vi.advanceTimersByTime(EVALUATION_FLUSH_MS)
    })
    vi.useRealTimers()
    const [r1, r2] = useAppStore.getState().unifiedRecordings
    expect(r1.evalStarLevel).toBe(5)
    expect(r1.evalKind).toBe('team_meeting')
    expect(r1.evalContext).toBe('work')
    expect(r2.evalStarLevel).toBeUndefined()
  })

  it('ignores other events and events for recordings not in the list', () => {
    vi.useFakeTimers()
    renderHook(() => useEvaluationUpdates())
    const before = useAppStore.getState().unifiedRecordings
    act(() => {
      listener?.({ type: 'audio:profiles-updated', payload: { recordingId: 'r1' } })
      listener?.({ type: 'evaluation:saved', payload: { recordingId: 'missing', starLevel: 3 } })
      listener?.({ type: 'evaluation:saved', payload: {} })
      vi.advanceTimersByTime(EVALUATION_FLUSH_MS)
    })
    vi.useRealTimers()
    expect(useAppStore.getState().unifiedRecordings).toBe(before)
  })

  it('applies a burst of evaluations (an overnight batch) in one update of the list', () => {
    vi.useFakeTimers()
    renderHook(() => useEvaluationUpdates())
    const updates: unknown[] = []
    const stop = useAppStore.subscribe((s, prev) => {
      if (s.unifiedRecordings !== prev.unifiedRecordings) updates.push(s.unifiedRecordings)
    })
    act(() => {
      listener?.({ type: 'evaluation:saved', payload: { recordingId: 'r1', starLevel: 4 } })
      listener?.({ type: 'evaluation:saved', payload: { recordingId: 'r2', starLevel: 2 } })
      vi.advanceTimersByTime(EVALUATION_FLUSH_MS)
    })
    stop()
    vi.useRealTimers()
    expect(updates).toHaveLength(1)
    expect(useAppStore.getState().unifiedRecordings.map((r) => r.evalStarLevel)).toEqual([4, 2])
  })

  it('stops listening when unmounted', () => {
    const { unmount } = renderHook(() => useEvaluationUpdates())
    unmount()
    expect(listener).toBeNull()
  })
})
