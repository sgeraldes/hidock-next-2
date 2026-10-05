import { createServer } from 'node:http'
import { once } from 'node:events'
// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { fetchPastePage as fetchPage, readablePage, pinnedPageTransport } from '../paste-page'

const publicDNS = async () => [{ address: '93.184.215.14', family: 4 }]
const fetchPastePage = (url: string, fetcher: typeof fetch) => fetchPage(url, fetcher, publicDNS)

it('extracts title and readable text without script/style content', () => {
  expect(readablePage('<title>A &amp; B</title><style>hidden</style><script>bad()</script><p>Hello</p><p>World</p>', 'https://example.com')).toEqual({ title: 'A & B', text: 'A & B\nHello\nWorld' })
})
it('fetches with no credentials, a deadline and bounded output', async () => {
  const fetcher = vi.fn(async () => new Response('<title>Page</title><p>Body</p>', { headers: { 'content-type': 'text/html' } }))
  expect(await fetchPastePage('https://example.com', fetcher)).toEqual({ title: 'Page', text: 'Page\nBody' })
  expect(fetcher).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal), redirect: 'manual' }), { address: '93.184.215.14', family: 4 })
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

it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '[::1]', '[::]', '[fe80::1]', '[fc00::1]', '[ff02::1]', '[::ffff:127.0.0.1]', '[::ffff:8.8.8.8]', '[2001:db8::1]', '[2001:100::1]', '[2002:7f00:1::]', '198.18.0.1', '240.0.0.1', '192.0.2.1'])('rejects non-public destination %s before transport', async (host) => {
  const fetcher = vi.fn(async () => new Response('private'))
  await expect(fetchPastePage(`http://${host}/`, fetcher)).rejects.toThrow('public')
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects DNS answers containing a private address and validates redirect destinations', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }))
  await expect(fetchPage('https://public.test', fetcher, async () => [{ address: '10.0.0.1', family: 4 }])).rejects.toThrow('public')
  expect(fetcher).not.toHaveBeenCalled()
  await expect(fetchPage('https://public.test', fetcher, publicDNS)).rejects.toThrow('public')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('pins the selected DNS address and follows only a bounded number of public redirects', async () => {
  const dns = vi.fn(publicDNS)
  const fetcher = vi.fn<import('../paste-page').PageTransport>(async () => new Response(null, { status: 302, headers: { location: '/again' } }))
  await expect(fetchPage('https://public.test', fetcher, dns)).rejects.toThrow('too many redirects')
  expect(fetcher).toHaveBeenCalledTimes(5)
  for (const call of fetcher.mock.calls) expect(call[2]).toEqual({ address: '93.184.215.14', family: 4 })
})

it.each([
  ['size', 200, 'text/plain', '2000000', '1 MB'],
  ['status', 403, 'text/plain', undefined, '403'],
  ['MIME', 200, 'application/octet-stream', undefined, 'readable text'],
  ['stream size', 200, 'text/plain', undefined, '1 MB']
] as const)('closes real fixture connection on rejected %s', async (reason, status, mime, length, error) => {
  let closed!: () => void
  const disconnected = new Promise<void>((resolve) => { closed = resolve })
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': mime, ...(length ? { 'content-length': length } : {}) })
    res.flushHeaders()
    const timer = setInterval(() => res.write(reason === 'stream size' ? Buffer.alloc(128 * 1024) : 'still streaming'), 5)
    res.on('close', () => { clearInterval(timer); closed() })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  try {
    // Only the fixture transport maps a validated public destination to our
    // owned loopback server; production's pinned transport has no such mapping.
    const transport = (url: string, init: RequestInit) => pinnedPageTransport(url, init, { address: '127.0.0.1', family: 4 })
    await expect(fetchPage(`http://public.test:${port}/`, transport, publicDNS)).rejects.toThrow(error)
    await Promise.race([disconnected, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Connection remained open')), 1000); timer.unref()
    })])
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

it('uses the real pinned transport for a public-host fixture and rejects its private redirect', async () => {
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url!)
    if (req.url === '/redirect') { res.writeHead(302, { location: '/private' }); res.end() }
    else { res.setHeader('content-type', 'text/plain'); res.end('Public fixture body') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  try {
    const transport = (url: string, init: RequestInit) => pinnedPageTransport(url, init, { address: '127.0.0.1', family: 4 })
    expect(await fetchPage(`http://public.test:${port}/ok`, transport, publicDNS)).toEqual({ title: 'public.test', text: 'Public fixture body' })
    const dns = vi.fn().mockResolvedValueOnce([{ address: '93.184.215.14', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    await expect(fetchPage(`http://public.test:${port}/redirect`, transport, dns)).rejects.toThrow('public')
    expect(paths).toEqual(['/ok', '/redirect'])
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})
