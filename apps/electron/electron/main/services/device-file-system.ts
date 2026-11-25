import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { setImmediate as yieldTurn } from 'node:timers/promises'

export interface DeviceFsFile { name: string; size: number; signature: string; modified: Date | null }
export interface DeviceFsCatalog { complete: boolean; deviceId: string; sessionId: string; files: DeviceFsFile[] }
export interface DeviceFsStore {
  catalog(): Promise<DeviceFsCatalog>
  read(file: DeviceFsFile, offset: number, count: number, signal: AbortSignal): Promise<Uint8Array>
}
export interface DeviceFsStatus { running: boolean; port: number | null; mountUrl: string | null; files: number; cachedBytes: number; readOnly: true }
export interface DeviceFsTrace { method: string; pathKind: 'root' | 'capability' | 'other'; pathShape: 'asterisk' | 'absolute' | 'cap-no-slash' | 'other'; status: number }
const BLOCK_BYTES = 1024 * 1024, CACHE_BYTES = BLOCK_BYTES
const MAX_REQUESTS = 16, MAX_READERS = 4, MAX_CATALOG_FILES = 4096, WRITE_BYTES = 64 * 1024
const xml = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const refusedMethods = new Set(['PUT', 'POST', 'DELETE', 'MOVE', 'COPY', 'MKCOL', 'LOCK', 'UNLOCK', 'PROPPATCH', 'PATCH'])
const cancelled = (): Error => new Error('Filesystem operation cancelled')
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal, milliseconds = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const abort = () => { clean(); reject(cancelled()) }
    const timer = setTimeout(() => { clean(); reject(Error('Filesystem provider deadline exceeded')) }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    promise.then(value => { clean(); resolve(value) }, error => { clean(); reject(error) })
  })
}
interface BlockJob { promise: Promise<Uint8Array>; controller: AbortController; subscribers: number }
interface Property { name: string; namespace: string }
interface PropertiesRequest { properties: Property[] | null; namesOnly: boolean }
const DAV = 'DAV:', MS = 'urn:schemas-microsoft-com:'
const standardProperties = ['displayname', 'resourcetype', 'getcontentlength', 'getcontenttype', 'getlastmodified', 'creationdate', 'getetag', 'supportedlock', 'lockdiscovery']

/** Read-only private loopback view; the injected adapter is the sole existing USB owner. */
export class DeviceFileSystem {
  private server: Server | null = null
  private token = randomBytes(24).toString('hex')
  private port: number | null = null
  private epoch = 0
  private invalidSession = false
  private startPromise: Promise<DeviceFsStatus> | null = null
  private stopPromise: Promise<void> | null = null
  private entries = new Map<string, { alias: string; file: DeviceFsFile }>()
  private binding: string | null = null
  private refreshPromise: Promise<void> | null = null
  private refreshEpoch = 0
  private catalogBusy = false
  private blocks = new Map<string, Uint8Array>()
  private inflight = new Map<string, BlockJob>()
  private cachedBytes = 0
  private readers = 0
  private readBusy = false
  private readWaiters: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void }> = []
  private requests = new Set<AbortController>()
  private trace: DeviceFsTrace[] = []
  constructor(private readonly store: DeviceFsStore) {}

  status(): DeviceFsStatus {
    return { running: this.server !== null && this.port !== null, port: this.port,
      mountUrl: this.port === null ? null : `http://127.0.0.1:${this.port}/${this.token}/`,
      files: this.entries.size, cachedBytes: this.cachedBytes, readOnly: true }
  }
  telemetry(): DeviceFsTrace[] { return this.trace.map(entry => ({ ...entry })) }
  async start(): Promise<DeviceFsStatus> {
    if (this.stopPromise) await this.stopPromise
    if (this.startPromise) return this.startPromise
    if (this.server && this.port !== null) return this.status()
    const epoch = this.epoch
    const pending = (async () => {
      await waitFor(this.refresh(epoch))
      if (epoch !== this.epoch) throw cancelled()
      const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 2000 }, (request, response) => { void this.handle(request, response, epoch) })
      server.maxConnections = 32; server.maxRequestsPerSocket = 64
      this.server = server
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
        if (epoch !== this.epoch || this.server !== server) {
          server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw cancelled()
        }
        this.port = (server.address() as AddressInfo).port
        return this.status()
      } catch (error) { if (this.server === server) { this.server = null; this.port = null }; throw error }
    })()
    this.startPromise = pending
    try { return await pending } finally { if (this.startPromise === pending) this.startPromise = null }
  }
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.epoch++
    for (const controller of this.requests) controller.abort('filesystem-stopped')
    for (const job of this.inflight.values()) job.controller.abort('filesystem-stopped')
    const server = this.server
    this.server = null; this.port = null; this.startPromise = null
    this.entries.clear(); this.binding = null; this.invalidSession = false
    this.blocks.clear(); this.cachedBytes = 0
    this.token = randomBytes(24).toString('hex')
    const pending = (async () => {
      server?.closeAllConnections()
      if (server) await new Promise<void>(resolve => server.close(() => resolve()))
      // A provider that ignores abort cannot restore cache/session state or create more read slots.
      await waitFor(Promise.allSettled([...this.inflight.values()].map(job => job.promise)), undefined, 5000).catch(() => undefined)
    })()
    this.stopPromise = pending
    try { await pending } finally { if (this.stopPromise === pending) this.stopPromise = null }
  }
  private invalidateSession(): void {
    this.invalidSession = true; this.entries.clear(); this.blocks.clear(); this.cachedBytes = 0
    for (const job of this.inflight.values()) job.controller.abort('device-session-changed')
  }
  private async refresh(epoch = this.epoch): Promise<void> {
    if (epoch !== this.epoch || this.invalidSession) throw Error('Device session changed; remount required')
    if (this.refreshPromise) {
      if (this.refreshEpoch === epoch) return this.refreshPromise
      await this.refreshPromise.catch(() => undefined)
      return this.refresh(epoch)
    }
    if (this.catalogBusy) throw Error('Catalog provider is still settling')
    this.refreshEpoch = epoch
    const pending = (async () => {
      this.catalogBusy = true
      const provider = Promise.resolve().then(() => this.store.catalog())
      void provider.finally(() => { this.catalogBusy = false }).catch(() => undefined)
      const catalog = await waitFor(provider)
      if (epoch !== this.epoch) throw cancelled()
      if (!catalog.complete || typeof catalog.deviceId !== 'string' || !catalog.deviceId || catalog.deviceId.length > 256 || typeof catalog.sessionId !== 'string' || !catalog.sessionId || catalog.sessionId.length > 256 || !Array.isArray(catalog.files) || catalog.files.length > MAX_CATALOG_FILES) throw Error('Device catalog incomplete or out of bounds')
      const binding = JSON.stringify([catalog.deviceId, catalog.sessionId])
      if (this.binding !== null && binding !== this.binding) { this.invalidateSession(); throw Error('Device session changed; remount required') }
      const next = new Map<string, { alias: string; file: DeviceFsFile }>()
      const names = new Set<string>()
      for (const file of [...catalog.files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (typeof file.name !== 'string' || !file.name || file.name.length > 255 || [...file.name].some(c => c.charCodeAt(0) < 32) || /[\\/]/.test(file.name) || file.name === '.' || file.name === '..' || names.has(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 0xffffffff || typeof file.signature !== 'string' || !file.signature || file.signature.length > 512) throw Error('Invalid device file metadata')
        names.add(file.name)
        let alias = file.name.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '')
        if (!alias || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(alias)) alias = `_${alias}`
        if (next.has(alias.toLowerCase())) alias = `${alias}~${hash(file.name).slice(0, 8)}`
        if (next.has(alias.toLowerCase())) throw Error('Device names cannot be represented uniquely')
        const modified = file.modified instanceof Date && Number.isFinite(file.modified.getTime()) ? new Date(file.modified) : null
        next.set(alias.toLowerCase(), { alias, file: { ...file, modified } })
      }
      // Deleted/replaced sources lose their retained cache immediately, not merely on eviction.
      const validPrefixes = new Set([...next.values()].map(entry => hash(JSON.stringify([binding, entry.file.name, entry.file.size, entry.file.signature]))))
      for (const [key, data] of this.blocks) if (!validPrefixes.has(key.split('|')[0])) { this.blocks.delete(key); this.cachedBytes -= data.length }
      this.binding = binding; this.entries = next
    })()
    this.refreshPromise = pending
    try { await pending } finally { if (this.refreshPromise === pending) this.refreshPromise = null }
  }
  private acquireRead(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancelled())
    if (!this.readBusy) { this.readBusy = true; return Promise.resolve(() => this.releaseRead()) }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => {} }
      waiter.abort = () => { const index = this.readWaiters.indexOf(waiter); if (index >= 0) this.readWaiters.splice(index, 1); reject(cancelled()) }
      this.readWaiters.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true })
    })
  }
  private releaseRead(): void {
    const next = this.readWaiters.shift()
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(() => this.releaseRead()) }
    else this.readBusy = false
  }
  private async block(file: DeviceFsFile, offset: number, signal: AbortSignal, epoch: number): Promise<Uint8Array> {
    await waitFor(this.refresh(epoch), signal)
    const current = [...this.entries.values()].find(entry => entry.file.name === file.name)?.file
    if (!current || current.size !== file.size || current.signature !== file.signature || epoch !== this.epoch) throw Error('Device file changed while reading')
    const count = Math.min(BLOCK_BYTES, file.size - offset)
    const key = `${hash(JSON.stringify([this.binding, file.name, file.size, file.signature]))}|${offset}|${count}`
    const cached = this.blocks.get(key)
    if (cached) { this.blocks.delete(key); this.blocks.set(key, cached); return cached }
    let job = this.inflight.get(key)
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController()
      const created: BlockJob = { controller, subscribers: 0, promise: Promise.resolve(new Uint8Array()) }
      created.promise = (async () => {
        const release = await this.acquireRead(controller.signal)
        try {
          if (controller.signal.aborted || epoch !== this.epoch) throw cancelled()
          const data = await this.store.read(file, offset, count, controller.signal)
          if (controller.signal.aborted || epoch !== this.epoch || this.invalidSession) throw cancelled()
          if (data.byteLength !== count) throw Error('Device read did not deliver exact requested bytes')
          const currentFile = [...this.entries.values()].find(entry => entry.file.name === file.name)?.file
          if (!currentFile || currentFile.size !== file.size || currentFile.signature !== file.signature) throw Error('Device file changed')
          const copy = new Uint8Array(data)
          while (this.cachedBytes + copy.byteLength > CACHE_BYTES && this.blocks.size) {
            const oldest = this.blocks.keys().next().value!
            this.cachedBytes -= this.blocks.get(oldest)!.length; this.blocks.delete(oldest)
          }
          this.blocks.set(key, copy); this.cachedBytes += copy.length
          return copy
        } finally { release() }
      })().finally(() => { if (this.inflight.get(key) === created) this.inflight.delete(key) })
      void created.promise.catch(() => undefined)
      this.inflight.set(key, created); job = created
    }
    const shared = job
    shared.subscribers++
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, data?: Uint8Array) => {
        if (settled) return
        settled = true; signal.removeEventListener('abort', abort); shared.subscribers--
        if (shared.subscribers === 0 && signal.aborted) shared.controller.abort('no-filesystem-subscribers')
        if (error) reject(error); else resolve(data!)
      }
      const abort = () => finish(cancelled())
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      shared.promise.then(data => finish(undefined, data), error => finish(error))
    })
  }
  private async write(response: ServerResponse, data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data
    for (let offset = 0; offset < bytes.length; offset += WRITE_BYTES) {
      if (response.destroyed) throw Error('Filesystem client disconnected')
      if (response.write(bytes.subarray(offset, Math.min(bytes.length, offset + WRITE_BYTES)))) continue
      await new Promise<void>((resolve, reject) => {
        const clean = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed) }
        const drained = () => { clean(); resolve() }, closed = () => { clean(); reject(cancelled()) }, failed = (error: Error) => { clean(); reject(error) }
        response.once('drain', drained); response.once('close', closed); response.once('error', failed)
      })
    }
  }
  private parseProperties(body: string): PropertiesRequest {
    if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw Error('Unsupported XML declaration')
    if (!body.trim() || /<(?:[\w.-]+:)?allprop\b/.test(body)) return { properties: null, namesOnly: false }
    if (/<(?:[\w.-]+:)?propname\b/.test(body)) return { properties: null, namesOnly: true }
    const prop = /<(?:[\w.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?prop\s*>/.exec(body)
    if (!prop) throw Error('Malformed property request')
    const namespaces = new Map<string, string>([['D', DAV]])
    for (const match of body.matchAll(/xmlns(?::([\w.-]+))?\s*=\s*["']([^"']+)["']/g)) namespaces.set(match[1] ?? '', match[2])
    const properties: Property[] = []
    for (const match of prop[1].matchAll(/<([\w.-]+:)?([A-Za-z_][\w.-]*)\b[^>]*>/g)) {
      properties.push({ name: match[2], namespace: namespaces.get((match[1] ?? '').replace(/:$/, '')) ?? '' })
      if (properties.length > 64) throw Error('Too many requested properties')
    }
    if (!properties.length && prop[1].trim()) throw Error('Malformed requested properties')
    return { properties, namesOnly: false }
  }
  private properties(alias: string, file: DeviceFsFile | null, requested: PropertiesRequest, serverRoot = false): string {
    const directory = file === null
    const href = serverRoot ? '/' : `/${this.token}/${directory ? '' : encodeURIComponent(alias)}`
    const values: Record<string, string> = { displayname: xml(directory ? 'HiDock' : alias), resourcetype: directory ? '<D:collection/>' : '',
      getcontentlength: String(file?.size ?? 0), getcontenttype: directory ? 'httpd/unix-directory' : 'application/octet-stream',
      supportedlock: '', lockdiscovery: '', iscollection: directory ? '1' : '0', isreadonly: '1' }
    if (file?.modified) values.getlastmodified = xml(file.modified.toUTCString())
    if (file) values.getetag = xml(`W/"${hash(JSON.stringify([this.binding, file.name, file.size, file.signature]))}"`)
    const properties = requested.properties ?? standardProperties.map(name => ({ name, namespace: DAV }))
    const good: string[] = [], missing: string[] = []
    for (const property of properties) {
      const tag = property.namespace === DAV ? `D:${property.name}` : property.namespace ? `P:${property.name}` : property.name
      const namespace = property.namespace && property.namespace !== DAV ? ` xmlns:P="${xml(property.namespace)}"` : ''
      let value: string | undefined = property.namespace === DAV && Object.hasOwn(values, property.name) ? values[property.name] : undefined
      if (property.namespace === MS && ['iscollection', 'isreadonly'].includes(property.name)) value = values[property.name]
      if (property.namespace === MS && property.name === 'Win32FileAttributes') value = directory ? '00000011' : '00000001'
      const element = `<${tag}${namespace}>${requested.namesOnly ? '' : value ?? ''}</${tag}>`
      if (value === undefined) missing.push(element); else good.push(element)
    }
    const stat = (properties: string[], status: number, message: string) => properties.length ? `<D:propstat><D:prop>${properties.join('')}</D:prop><D:status>HTTP/1.1 ${status} ${message}</D:status></D:propstat>` : ''
    return `<D:response><D:href>${xml(href)}</D:href>${stat(good, 200, 'OK')}${stat(missing, 404, 'Not Found')}</D:response>`
  }
  private async handle(request: IncomingMessage, response: ServerResponse, epoch: number): Promise<void> {
    const controller = new AbortController()
    this.requests.add(controller)
    const methodName = request.method ?? 'GET'
    const safeMethod = ['OPTIONS', 'PROPFIND', 'HEAD', 'GET', ...refusedMethods].includes(methodName) ? methodName : 'OTHER'
    const incoming = request.url ?? '/'
    const pathShape: DeviceFsTrace['pathShape'] = incoming === '*' ? 'asterisk' : /^https?:\/\//i.test(incoming) ? 'absolute' : incoming.split('?')[0] === `/${this.token}` ? 'cap-no-slash' : 'other'
    let tracePath = incoming.split('?')[0]
    if (pathShape === 'absolute') { try { tracePath = new URL(incoming).pathname } catch { tracePath = '' } }
    const pathKind: DeviceFsTrace['pathKind'] = tracePath === '/' || incoming === '*' ? 'root' : tracePath === `/${this.token}` || tracePath.startsWith(`/${this.token}/`) ? 'capability' : 'other'
    let recorded = false
    const record = (status: number) => { if (recorded) return; recorded = true; this.trace.push({ method: safeMethod, pathKind, pathShape, status }); if (this.trace.length > 64) this.trace.shift() }
    response.once('finish', () => record(response.statusCode))
    response.once('close', () => { if (!response.writableFinished) record(499) })
    const timeout = setTimeout(() => { controller.abort('filesystem-request-timeout'); response.destroy() }, 60000)
    response.once('close', () => { if (!response.writableEnded) controller.abort('client-disconnected') })
    let reading = false
    try {
      if (epoch !== this.epoch || request.headers.host !== `127.0.0.1:${this.port}` || !request.socket.remoteAddress?.match(/^(127\.0\.0\.1|::ffff:127\.0\.0\.1)$/)) { response.writeHead(403); response.end(); return }
      const prefix = `/${this.token}/`
      let rawPath = incoming.split('?')[0]
      const asterisk = incoming === '*'
      if (pathShape === 'absolute') {
        let absolute: URL
        try { absolute = new URL(incoming) } catch { response.writeHead(400); response.end(); return }
        if (absolute.origin !== `http://127.0.0.1:${this.port}` || absolute.username || absolute.password) { response.writeHead(403); response.end(); return }
        rawPath = absolute.pathname
      }
      if (asterisk) { if (request.method !== 'OPTIONS') { response.writeHead(400); response.end(); return }; rawPath = '/' }
      let decoded: string
      try { decoded = decodeURIComponent(rawPath) } catch { response.writeHead(400); response.end(); return }
      if (!rawPath.startsWith('/') || rawPath.includes('#')) { response.writeHead(400); response.end(); return }
      const serverRoot = decoded === '/' && rawPath === '/'
      const capabilityRoot = decoded === `/${this.token}`
      if (!serverRoot && !capabilityRoot && !decoded.startsWith(prefix)) { response.writeHead(403); response.end(); return }
      let name = serverRoot || capabilityRoot ? '' : decoded.slice(prefix.length)
      if (name.endsWith('/')) name = name.slice(0, -1)
      if (/[\\/]/.test(name) || [...name].some(c => c.charCodeAt(0) < 32) || name === '.' || name === '..') { response.writeHead(400); response.end(); return }
      const method = request.method ?? 'GET'
      if (serverRoot && !(method === 'OPTIONS' || method === 'PROPFIND' && request.headers.depth === '0')) { response.writeHead(403); response.end(); return }
      response.setHeader('DAV', '1'); response.setHeader('MS-Author-Via', 'DAV'); response.setHeader('Cache-Control', 'private, no-cache')
      if (refusedMethods.has(method)) { response.writeHead(403); response.end('Device filesystem is read-only'); return }
      if (this.requests.size > MAX_REQUESTS) { response.writeHead(503); response.end(); return }
      if (method === 'OPTIONS') { response.setHeader('Allow', 'OPTIONS, PROPFIND, HEAD, GET'); response.writeHead(200); response.end(); return }
      if (!['PROPFIND', 'HEAD', 'GET'].includes(method)) { response.writeHead(405); response.end(); return }
      if (method !== 'PROPFIND' && (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'])) { response.writeHead(400); response.end(); return }
      if (!serverRoot) await waitFor(this.refresh(epoch), controller.signal)
      const entry = name ? this.entries.get(name.toLowerCase()) : null
      if (name && !entry) { response.writeHead(404); response.end(); return }
      if (method === 'PROPFIND') {
        if (request.headers.depth && !['0', '1'].includes(String(request.headers.depth))) { response.writeHead(403); response.end(); return }
        if (Number(request.headers['content-length'] ?? 0) > 16384) { response.writeHead(413); response.end(); return }
        let length = 0; const chunks: Buffer[] = []
        for await (const bytes of request) { length += bytes.length; if (length > 16384) { response.writeHead(413); response.end(); return }; chunks.push(Buffer.from(bytes)) }
        let properties: PropertiesRequest
        try { properties = this.parseProperties(Buffer.concat(chunks).toString('utf8')) } catch { response.writeHead(400); response.end(); return }
        response.setHeader('Content-Type', 'application/xml; charset=utf-8'); response.writeHead(207)
        await this.write(response, '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">')
        await this.write(response, this.properties(entry?.alias ?? '', entry?.file ?? null, properties, serverRoot))
        if (!serverRoot && !entry && request.headers.depth !== '0') {
          let count = 0
          for (const child of this.entries.values()) { await this.write(response, this.properties(child.alias, child.file, properties)); if (++count % 64 === 0) await yieldTurn() }
        }
        response.end('</D:multistatus>'); return
      }
      if (!entry) { response.writeHead(200, { 'Content-Length': 0 }); response.end(); return }
      const { file } = entry
      let start = 0, end = file.size - 1, status = 200
      const header = request.headers.range
      if (header) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(header)
        if (!match || (!match[1] && !match[2]) || !file.size) { response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); response.end(); return }
        if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, file.size - suffix); if (!Number.isSafeInteger(suffix) || suffix <= 0) start = file.size }
        else { start = Number(match[1]); if (match[2] && !Number.isSafeInteger(Number(match[2]))) { response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); response.end(); return }; end = match[2] ? Math.min(Number(match[2]), end) : end }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= file.size || end < start) { response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); response.end(); return }
        status = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`)
      }
      if (method === 'GET') { if (this.readers >= MAX_READERS) { response.writeHead(503); response.end(); return }; this.readers++; reading = true }
      response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Content-Length', Math.max(0, end - start + 1)); response.setHeader('Content-Type', 'application/octet-stream')
      response.setHeader('ETag', `W/"${hash(JSON.stringify([this.binding, file.name, file.size, file.signature]))}"`)
      if (file.modified) response.setHeader('Last-Modified', file.modified.toUTCString())
      response.writeHead(status)
      if (method === 'HEAD' || !file.size) { response.end(); return }
      for (let position = start; position <= end;) {
        if (controller.signal.aborted || epoch !== this.epoch) throw cancelled()
        const blockStart = Math.floor(position / BLOCK_BYTES) * BLOCK_BYTES
        const data = await this.block(file, blockStart, controller.signal, epoch)
        const take = Math.min(end - position + 1, data.length - (position - blockStart))
        if (take <= 0) throw Error('Filesystem read did not advance')
        await this.write(response, data.subarray(position - blockStart, position - blockStart + take))
        position += take
      }
      response.end()
    } catch {
      if (!response.headersSent && !response.destroyed) { response.writeHead(503); response.end('Device filesystem unavailable or changed') }
      else response.destroy()
    } finally { clearTimeout(timeout); this.requests.delete(controller); if (reading) this.readers-- }
  }
}
