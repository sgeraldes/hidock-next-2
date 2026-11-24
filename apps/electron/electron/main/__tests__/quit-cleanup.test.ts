/** @vitest-environment node */
import { expect, it, vi } from 'vitest'
import { createQuitCleanup } from '../quit-cleanup'

it('holds repeated quit requests until asynchronous recording cleanup finishes', async () => {
  let flush!: () => void
  const cleanup = vi.fn(() => new Promise<void>((resolve) => { flush = resolve }))
  const quit = vi.fn()
  const handler = createQuitCleanup(cleanup, quit)
  const first = { preventDefault: vi.fn() }, second = { preventDefault: vi.fn() }
  handler(first); handler(second)
  expect(first.preventDefault).toHaveBeenCalledOnce()
  expect(second.preventDefault).toHaveBeenCalledOnce()
  expect(cleanup).toHaveBeenCalledOnce()
  expect(quit).not.toHaveBeenCalled()
  flush()
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  const final = { preventDefault: vi.fn() }
  handler(final)
  expect(final.preventDefault).not.toHaveBeenCalled()
  expect(cleanup).toHaveBeenCalledOnce()
})
