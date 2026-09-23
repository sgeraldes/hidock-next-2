import { expect, it, vi } from 'vitest'

/**
 * The setup-db.ts afterAll must call the tracker directly. Reintroducing a
 * setImmediate defer makes this file's teardown invoke the throwing stub.
 */
it('does not defer setup-db teardown through setImmediate', () => {
  vi.stubGlobal('setImmediate', () => {
    throw new Error('setup-db teardown must not depend on setImmediate')
  })

  expect(setImmediate).toBeTypeOf('function')
})
