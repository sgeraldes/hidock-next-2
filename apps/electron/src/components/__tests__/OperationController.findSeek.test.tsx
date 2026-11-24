import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAudioControls } from '../OperationController'

describe('Audio controls find seek forwarding', () => {
  it('preserves existing calls and forwards the explicit paused-load flag', () => {
    const play = vi.fn().mockResolvedValue(undefined)
    window.__audioControls = { play } as unknown as NonNullable<Window['__audioControls']>
    const { result } = renderHook(() => useAudioControls())
    result.current.play('a', '/a.wav')
    expect(play).toHaveBeenLastCalledWith('a', '/a.wav')
    result.current.play('a', '/a.wav', 30)
    expect(play).toHaveBeenLastCalledWith('a', '/a.wav', 30)
    result.current.play('a', '/a.wav', 30, false)
    expect(play).toHaveBeenLastCalledWith('a', '/a.wav', 30, false)
    result.current.play('a', '/a.wav', undefined, false)
    expect(play).toHaveBeenLastCalledWith('a', '/a.wav', undefined, false)
  })
})
