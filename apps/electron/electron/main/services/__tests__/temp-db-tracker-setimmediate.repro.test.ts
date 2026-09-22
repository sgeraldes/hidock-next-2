import { expect, it, vi } from 'vitest'

/**
 * setup-db.ts previously deferred its afterAll cleanup through setImmediate.
 * The replacement throws if that timer-based dependency returns, so the old
 * cleanup hook fails after this test and the synchronous sweep passes.
 */
it('does not defer tracker cleanup through setImmediate', () => {
  vi.stubGlobal('setImmediate', () => {
    throw new Error('temp DB cleanup must not depend on setImmediate')
  })

  expect(setImmediate).toBeTypeOf('function')
})
