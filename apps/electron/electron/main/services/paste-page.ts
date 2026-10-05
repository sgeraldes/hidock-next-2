import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6) return false
  // Only global unicast; this also rejects mapped/compatible IPv4, ULA,
  // multicast, link-local, unspecified and loopback representations.
  const first = parseInt(address.split(':')[0], 16)
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
  const second = parseInt(canonical.split(':')[1] || '0', 16)
  return !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && first !== 0x2002 && first !== 0x3fff
}

export type PageResolver = (host: string) => Promise<Array<{ address: string; family: number }>>
export type PageTransport = (url: string, init: RequestInit, address: { address: string; family: number }) => Promise<Response>

/** Direct sockets bypass proxies and never resolve the host a second time. */
export const pinnedPageTransport: PageTransport = (url, init, address) => new Promise((resolve, reject) => {
  const parsed = new URL(url)
  const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed, {
    agent: false,
    family: address.family,
    signal: init.signal ?? undefined,
    headers: { Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity' },
    lookup: (_host, _options, callback) => callback(null, address.address, address.family)
  }, (incoming) => {
    const headers = new Headers()
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    // Keep the request abortable until its response stream has been torn down.
    const status = incoming.statusCode ?? 500
    const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
    if (!body) incoming.resume()
    resolve(new Response(body, { status, headers }))
  })
  request.on('error', reject)
  request.end()
})

const MAX_PAGE_BYTES = 1024 * 1024
const MAX_TEXT_CHARS = 100_000

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]
    const hex = entity.toLowerCase().startsWith('&#x')
    const value = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
  })
}

export function readablePage(html: string, url: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, '').trim() || new URL(url).hostname).slice(0, 200)
  const text = decodeEntities(html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[^]*?-->/g, '').replace(/<\/?(?:p|div|br|li|h[1-6]|section|article|title)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')).replace(/[\t \r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, MAX_TEXT_CHARS)
  return { title, text }
}

export async function fetchPastePage(
  url: string,
  transport: PageTransport = pinnedPageTransport,
  resolve: PageResolver = (host) => lookup(host, { all: true, verbatim: true })
): Promise<{ title: string; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let parsed = new URL(url)
    for (let hop = 0; ; hop++) {
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only HTTP and HTTPS links can be fetched.')
      if (parsed.username || parsed.password) throw new Error('Links containing credentials cannot be fetched.')
      const host = parsed.hostname.replace(/^\[|\]$/g, '')
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
        resolve(host), new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('Page fetch timed out after 10 seconds.')), { once: true })
        })
      ])
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Only public network addresses can be fetched.')
      controller.signal.throwIfAborted()
      response = await transport(parsed.href, { credentials: 'omit', redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html,text/plain' } }, addresses[0])
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      await response.body?.cancel()
      response = undefined
      if (!location) throw new Error('Page redirect has no destination.')
      if (hop >= 4) throw new Error('Page has too many redirects.')
      parsed = new URL(location, parsed)
    }
    if (!response.ok) throw new Error(`Page fetch failed: HTTP ${response.status}`)
    const mime = response.headers.get('content-type') ?? ''
    if (mime && !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(mime)) throw new Error(`Page is not readable text (${mime}).`)
    if (Number(response.headers.get('content-length')) > MAX_PAGE_BYTES) throw new Error('Page exceeds the 1 MB limit.')
    reader = response.body?.getReader()
    if (!reader) return { title: parsed.hostname, text: '' }
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_PAGE_BYTES) throw new Error('Page exceeds the 1 MB limit.')
      chunks.push(value)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    return mime.includes('text/plain') ? { title: parsed.hostname, text: body.slice(0, MAX_TEXT_CHARS) } : readablePage(body, parsed.href)
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Page fetch timed out after 10 seconds.', { cause: error })
    throw error
  } finally {
    controller.abort()
    try { if (reader) await reader.cancel(); else await response?.body?.cancel() }
    finally { clearTimeout(timer) }
  }
}
