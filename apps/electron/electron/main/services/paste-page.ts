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

export async function fetchPastePage(url: string, fetcher: typeof fetch): Promise<{ title: string; text: string }> {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only HTTP and HTTPS links can be fetched.')
  if (parsed.username || parsed.password) throw new Error('Links containing credentials cannot be fetched.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetcher(url, { credentials: 'omit', signal: controller.signal, headers: { Accept: 'text/html,text/plain' } })
    if (!response.ok) throw new Error(`Page fetch failed: HTTP ${response.status}`)
    const mime = response.headers.get('content-type') ?? ''
    if (mime && !/text\/(html|plain)|application\/xhtml\+xml/i.test(mime)) throw new Error(`Page is not readable text (${mime}).`)
    if (Number(response.headers.get('content-length')) > MAX_PAGE_BYTES) throw new Error('Page exceeds the 1 MB limit.')
    const reader = response.body?.getReader()
    if (!reader) return { title: parsed.hostname, text: '' }
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_PAGE_BYTES) throw new Error('Page exceeds the 1 MB limit.')
        chunks.push(value)
      }
    } finally { await reader.cancel() }
    const body = Buffer.concat(chunks).toString('utf8')
    return mime.includes('text/plain') ? { title: parsed.hostname, text: body.slice(0, MAX_TEXT_CHARS) } : readablePage(body, url)
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Page fetch timed out after 10 seconds.', { cause: error })
    throw error
  } finally { clearTimeout(timer) }
}
