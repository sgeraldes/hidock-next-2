// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mainThreadBudget } from '../event-loop'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it('does not report provider wait time as a main-thread hold', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] })
  const warn = vi.spyOn(console, 'warn')
  const checkpoint = mainThreadBudget('ProviderLoop')
  await vi.advanceTimersByTimeAsync(500)
  checkpoint.reset()
  await checkpoint()
  expect(warn).not.toHaveBeenCalled()
})
it('reports an actual over-budget synchronous interval and yields', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const checkpoint = mainThreadBudget('CorpusPass')
  vi.advanceTimersByTime(135)
  const pending = checkpoint()
  expect(warn).toHaveBeenCalledWith('[CorpusPass] batch held the main thread for 135ms')
  await vi.runAllTimersAsync()
  await pending
})
