// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { fetchPastePage, readablePage } from '../paste-page'

it('extracts title and readable text without script/style content', () => {
  expect(readablePage('<title>A &amp; B</title><style>hidden</style><script>bad()</script><p>Hello</p><p>World</p>', 'https://example.com')).toEqual({ title: 'A & B', text: 'A & B\nHello\nWorld' })
})
it('fetches with no credentials, a deadline and bounded output', async () => {
  const fetcher = vi.fn(async () => new Response('<title>Page</title><p>Body</p>', { headers: { 'content-type': 'text/html' } }))
  expect(await fetchPastePage('https://example.com', fetcher)).toEqual({ title: 'Page', text: 'Page\nBody' })
  expect(fetcher).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }))
})
it('rejects credentials, non-web URLs and HTTP errors', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 403 }))
  await expect(fetchPastePage('https://user:secret@example.com', fetcher)).rejects.toThrow('credentials') // pragma: allowlist secret -- fake rejection fixture
  await expect(fetchPastePage('file:///secret', fetcher)).rejects.toThrow('HTTP')
  await expect(fetchPastePage('https://example.com', fetcher)).rejects.toThrow('403')
})
it('caps responses before reading the whole body', async () => {
  const fetcher = vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1)))
  await expect(fetchPastePage('https://example.com', fetcher)).rejects.toThrow('1 MB')
})
