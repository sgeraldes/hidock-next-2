// @vitest-environment node

/**
 * Jev (TypeSafe AI System One) HTTP client: request shape per
 * https://docs.typesafe.ai/api, answers passed through, and failures raised
 * as JevError with the HTTP status. fetch is injected; nothing leaves the test.
 */

import { describe, it, expect, vi } from 'vitest'
import { askJev, JevError, JEV_ENDPOINT, JEV_MODEL } from '../jev-client'

const KEY = 'jev-test-key' // pragma: allowlist secret

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('askJev', () => {
  it('posts state, model and questions with the bearer key and returns the answers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_urgent: { type: 'noul', noul: 0.95 } },
        usage: { input_tokens: 296, output_tokens: 20 }
      })
    )

    const res = await askJev(KEY, 'Help! Payouts failing.', { is_urgent: { type: 'noul', instructions: 'Urgent?' } }, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(res.answers.is_urgent).toEqual({ type: 'noul', noul: 0.95 })
    expect(res.usage.input_tokens).toBe(296)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(JEV_ENDPOINT)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(String(init.body))).toEqual({
      state: 'Help! Payouts failing.',
      model: JEV_MODEL,
      questions: { is_urgent: { type: 'noul', instructions: 'Urgent?' } }
    })
  })

  it('raises JevError with the status on 401 (bad key) and 529 (overloaded)', async () => {
    for (const status of [401, 529]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { detail: 'nope' }))
      const err = await askJev(KEY, 's', {}, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e)
      expect(err).toBeInstanceOf(JevError)
      expect((err as JevError).status).toBe(status)
      expect(String(err.message)).toContain(`HTTP ${status}`)
    }
  })

  it('never echoes the key in an error message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { detail: 'questions.value.criteria is required' }))
    const err = await askJev(KEY, 's', {}, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e)
    expect(String(err.message)).toContain('criteria is required')
    expect(String(err.message)).not.toContain(KEY)
  })

  it('raises JevError on a network failure and on a response without answers', async () => {
    const down = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.typesafe.ai')
    })
    const netErr = await askJev(KEY, 's', {}, { fetchImpl: down as unknown as typeof fetch }).catch((e) => e)
    expect(netErr).toBeInstanceOf(JevError)
    expect((netErr as JevError).status).toBeNull()

    const empty = vi.fn(async () => jsonResponse(200, { model: 'jev-1.13.0' }))
    const shapeErr = await askJev(KEY, 's', {}, { fetchImpl: empty as unknown as typeof fetch }).catch((e) => e)
    expect(shapeErr).toBeInstanceOf(JevError)
  })

  it('refuses to call without a key', async () => {
    const fetchImpl = vi.fn()
    await expect(askJev('  ', 's', {}, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(JevError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
