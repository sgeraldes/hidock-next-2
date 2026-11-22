import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useRecordingAudioMetadata } from '../useRecordingAudioMetadata'

const facts = { status: 'verified', byteLength: 2092 }
describe('selected audio facts response ownership', () => {
  it('drops a late response from the previous selection', async () => {
    let resolveOld!: (value: any) => void
    const getAudioMetadata = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({ success: true, data: facts })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { storage: { getAudioMetadata } } })
    const { result, rerender } = renderHook(({ id }) => useRecordingAudioMetadata(id), { initialProps: { id: 'old' } })
    rerender({ id: 'new' })
    await waitFor(() => expect(result.current).toEqual(facts))
    await act(async () => resolveOld({ success: true, data: { ...facts, byteLength: 99 } }))
    expect(result.current).toEqual(facts)
  })
  it('refetches a changed source under the same ID and clears old facts on failure', async () => {
    const getAudioMetadata = vi.fn().mockResolvedValueOnce({ success: true, data: facts })
      .mockResolvedValueOnce({ success: false, error: 'Recording removed' })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { storage: { getAudioMetadata } } })
    const { result, rerender } = renderHook(({ revision }) => useRecordingAudioMetadata('same', revision), {
      initialProps: { revision: 'path-a:2092' }
    })
    await waitFor(() => expect(result.current).toEqual(facts))
    rerender({ revision: 'path-b:2092' })
    expect(result.current).toBeNull()
    await waitFor(() => expect(getAudioMetadata).toHaveBeenCalledTimes(2))
    expect(result.current).toBeNull()
  })
})
