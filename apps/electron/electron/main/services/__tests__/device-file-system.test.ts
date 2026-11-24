// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http'
import { createHash } from 'node:crypto'
import { DeviceFileSystem, type DeviceFsCatalog, type DeviceFsStore, type DeviceFsFile } from '../device-file-system'

const MB = 1024 * 1024
const live: DeviceFileSystem[] = []
afterEach(async () => { await Promise.all(live.splice(0).map(fs => fs.stop())) })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const safeXml = (body: Buffer) => body.toString().replace(/[a-f0-9]{48}/g, '[private-capability]')
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture(size = 2 * MB + 91) {
  const data = Buffer.alloc(size); for (let n = 0; n < size; n++) data[n] = (n * 13 + (n >>> 10)) & 255
  const file: DeviceFsFile = { name: 'closed.hda', size, signature: 'stable-one', modified: null }
  const catalog: DeviceFsCatalog = { complete: true, deviceId: 'fixture-device', sessionId: 'fixture-session', files: [file] }
  const reads: Array<{ name: string; offset: number; count: number }> = []
  let catalogCalls = 0
  const store: DeviceFsStore = { catalog: async () => { catalogCalls++; return catalog }, read: async (source, offset, count, signal) => {
    if (signal.aborted) throw Error('aborted fixture read')
    reads.push({ name: source.name, offset, count }); return data.subarray(offset, offset + count)
  } }
  const fs = new DeviceFileSystem(store); live.push(fs)
  return { fs, store, catalog, file, data, reads, catalogCalls: () => catalogCalls }
}
interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer }
function send(url: string, method = 'GET', suffix = '', headers: Record<string, string> = {}, body = ''): { request: ClientRequest; promise: Promise<Reply> } {
  const parsed = new URL(url)
  let request!: ClientRequest
  const promise = new Promise<Reply>((resolve, reject) => {
    request = httpRequest({ host: '127.0.0.1', port: parsed.port, path: parsed.pathname + suffix, method, headers,
      agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', bytes => chunks.push(Buffer.from(bytes)))
      response.once('aborted', () => reject(Error('HTTP response interrupted')))
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.once('error', reject); request.end(body)
  })
  void promise.catch(() => undefined)
  return { request, promise }
}
function sendPath(mount: string, path: string, method = 'OPTIONS', headers: Record<string, string> = {}): Promise<Reply> {
  const address = new URL(mount)
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path, method, headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', bytes => chunks.push(Buffer.from(bytes)))
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.once('error', reject); request.end()
  })
}
async function url(fs: DeviceFileSystem): Promise<string> { const status = await fs.start(); if (!status.mountUrl) throw Error('Filesystem did not start'); return status.mountUrl }

describe('read-only device filesystem through real loopback HTTP', () => {
  it('coalesces concurrent starts and serves exact multi-block bytes/ranges without a whole-file provider read', async () => {
    const f = fixture()
    const states = await Promise.all([f.fs.start(), f.fs.start(), f.fs.start()])
    expect(new Set(states.map(state => state.port)).size).toBe(1)
    expect(f.catalogCalls()).toBe(1)
    const mount = states[0].mountUrl!
    const result = await send(mount, 'GET', 'closed.hda').promise
    expect(result.status).toBe(200); expect(result.body).toEqual(f.data)
    expect(f.reads.map(read => read.count)).toEqual([MB, MB, 91])
    expect(f.fs.status().cachedBytes).toBeLessThanOrEqual(MB)
    const partial = await send(mount, 'GET', 'closed.hda', { Range: 'bytes=1048560-1048600' }).promise
    expect(partial.status).toBe(206); expect(partial.body).toEqual(f.data.subarray(1048560, 1048601))
    expect(partial.headers['content-range']).toBe(`bytes 1048560-1048600/${f.file.size}`)
  })

  it('HEAD does not read bytes, suffix ranges are exact, unknown times stay absent', async () => {
    const f = fixture(100), mount = await url(f.fs)
    const head = await send(mount, 'HEAD', 'closed.hda').promise
    expect(head.status).toBe(200); expect(head.body.length).toBe(0); expect(f.reads).toHaveLength(0)
    expect(head.headers['last-modified']).toBeUndefined()
    const suffix = await send(mount, 'GET', 'closed.hda', { Range: 'bytes=-7' }).promise
    expect(suffix.body).toEqual(f.data.subarray(93)); expect(suffix.status).toBe(206)
  })

  for (const range of ['bytes=', 'bytes=4-2', 'bytes=999-1000', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=0-999999999999999999999']) {
    it(`rejects malformed/out-of-bounds range ${range}`, async () => {
      const f = fixture(100), mount = await url(f.fs)
      expect((await send(mount, 'GET', 'closed.hda', { Range: range }).promise).status).toBe(416)
      expect(f.reads).toHaveLength(0)
    })
  }

  for (const method of ['PUT', 'DELETE', 'MOVE', 'MKCOL', 'LOCK', 'PROPPATCH']) {
    it(`refuses ${method} without invoking a provider read`, async () => {
      const f = fixture(100), mount = await url(f.fs)
      expect((await send(mount, method, 'closed.hda').promise).status).toBe(403)
      expect(f.reads).toHaveLength(0)
    })
  }

  for (const suffix of ['%', '%GG', '%2e%2e', 'a%2fb', 'a%5cb', '%00']) {
    it(`returns400 for invalid URI ${suffix}`, async () => {
      const f = fixture(100), mount = await url(f.fs)
      expect((await send(mount, 'GET', suffix).promise).status).toBe(400)
      expect(f.reads).toHaveLength(0)
    })
  }

  it('private capability is required; server-root Windows probes expose no capability or catalog', async () => {
    const f = fixture(100), mount = await url(f.fs), base = new URL('/', mount).toString(), before = f.catalogCalls()
    expect((await send(base, 'GET').promise).status).toBe(403)
    expect((await send(base, 'OPTIONS').promise).status).toBe(200)
    expect((await send(base, 'PROPFIND', '', { Depth: '1' }).promise).status).toBe(403)
    const root = await send(base, 'PROPFIND', '', { Depth: '0' }).promise
    expect(root.status).toBe(207)
    expect(root.body.toString().includes(new URL(mount).pathname)).toBe(false)
    expect(safeXml(root.body)).not.toContain('closed.hda')
    expect(f.catalogCalls()).toBe(before)
    expect((await send(base, 'GET', 'wrong/closed.hda').promise).status).toBe(403)
  })

  it('supports Windows no-slash capability and same-origin absolute OPTIONS; generic asterisk exposes no catalog', async () => {
    const f = fixture(100), mount = await url(f.fs), address = new URL(mount), before = f.catalogCalls()
    expect((await sendPath(mount, address.pathname.slice(0, -1))).status).toBe(200)
    const noSlash = await sendPath(mount, address.pathname.slice(0, -1), 'PROPFIND', { Depth: '1' })
    expect(noSlash.status).toBe(207); expect(safeXml(noSlash.body)).toContain('closed.hda')
    expect((await sendPath(mount, mount, 'OPTIONS')).status).toBe(200)
    const star = await sendPath(mount, '*', 'OPTIONS')
    expect(star.status).toBe(200); expect(star.body.length).toBe(0)
    expect((await sendPath(mount, '*', 'PROPFIND', { Depth: '0' })).status).toBe(400)
    expect((await sendPath(mount, 'http://example.invalid/', 'OPTIONS')).status).toBe(403)
    expect((await sendPath(mount, mount, 'OPTIONS', { Host: 'example.invalid' })).status).toBe(403)
    expect(f.reads).toHaveLength(0)
    expect(f.catalogCalls()).toBe(before + 1) // Only the authorized private PROPFIND enumerated.
    expect(f.fs.telemetry().some(row => row.pathShape === 'asterisk')).toBe(true)
    expect(f.fs.telemetry().some(row => row.pathShape === 'absolute')).toBe(true)
    expect(f.fs.telemetry().some(row => row.pathShape === 'cap-no-slash')).toBe(true)
  })

  it('Windows requested properties return known values200 and unknown/creation times404', async () => {
    const f = fixture(100), mount = await url(f.fs)
    const body = '<D:propfind xmlns:D="DAV:" xmlns:W="urn:schemas-microsoft-com:"><D:prop><D:getcontentlength/><D:getlastmodified/><D:creationdate/><D:constructor/><W:Win32FileAttributes/><D:unknown/></D:prop></D:propfind>'
    const response = await send(mount, 'PROPFIND', 'closed.hda', { Depth: '0', 'Content-Length': String(Buffer.byteLength(body)) }, body).promise
    const text = safeXml(response.body)
    expect(response.status).toBe(207)
    expect(text).toContain('<D:getcontentlength>100</D:getcontentlength>')
    expect(text).toContain('HTTP/1.1 404 Not Found')
    expect(text).toContain('<D:creationdate></D:creationdate>')
    expect(text).toContain('<D:constructor></D:constructor>')
    expect(text).toContain('Win32FileAttributes'); expect(text).toContain('00000001')
    expect(text).not.toContain('function Object')
    expect(f.reads).toHaveLength(0)
  })

  it('bounds PROPFIND bodies and rejects DTD declarations', async () => {
    const f = fixture(100), mount = await url(f.fs)
    expect((await send(mount, 'PROPFIND', '', { Depth: '0', 'Content-Length': '16385' }, 'x'.repeat(16385)).promise).status).toBe(413)
    const body = '<!DOCTYPE p><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'
    expect((await send(mount, 'PROPFIND', '', { Depth: '0' }, body).promise).status).toBe(400)
  })

  it('coalesced read survives the first client abort while another still needs the block', async () => {
    const f = fixture(100), gate = deferred<void>(), entered = deferred<void>(), mount = await url(f.fs)
    let calls = 0, providerAborted = false
    f.store.read = async (_file, offset, count, signal) => { calls++; entered.resolve(); signal.addEventListener('abort', () => { providerAborted = true }); await gate.promise; return f.data.subarray(offset, offset + count) }
    const a = send(mount, 'GET', 'closed.hda'), b = send(mount, 'GET', 'closed.hda')
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 25))
    a.request.destroy(); await a.promise.catch(() => undefined); await turn()
    expect(providerAborted).toBe(false)
    gate.resolve()
    const result = await b.promise
    expect(result.status).toBe(200); expect(result.body).toEqual(f.data); expect(calls).toBe(1)
  })

  it('a new client is not attached to an abandoned aborted read', async () => {
    const f = fixture(100), gate = deferred<void>(), entered = deferred<void>(), mount = await url(f.fs)
    let calls = 0, firstAborted = false
    f.store.read = async (_file, offset, count, signal) => {
      calls++
      if (calls === 1) { entered.resolve(); signal.addEventListener('abort', () => { firstAborted = true }); await gate.promise }
      return f.data.subarray(offset, offset + count)
    }
    const first = send(mount, 'GET', 'closed.hda')
    await entered.promise; first.request.destroy(); await first.promise.catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(firstAborted).toBe(true)
    const next = send(mount, 'GET', 'closed.hda')
    gate.resolve()
    const result = await next.promise
    expect(result.status).toBe(200); expect(result.body).toEqual(f.data); expect(calls).toBe(2)
  })

  it('bounds simultaneous readers and serializes distinct provider reads', async () => {
    const f = fixture(100), gate = deferred<void>(), entered = deferred<void>(), mount = await url(f.fs)
    f.catalog.files = Array.from({ length: 5 }, (_, n) => ({ ...f.file, name: `f${n}.hda` }))
    let active = 0, maximum = 0
    f.store.read = async (_file, offset, count) => { active++; maximum = Math.max(maximum, active); entered.resolve(); await gate.promise; active--; return f.data.subarray(offset, offset + count) }
    const first = Array.from({ length: 4 }, (_, n) => send(mount, 'GET', `f${n}.hda`))
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 25))
    const fifth = await send(mount, 'GET', 'f4.hda').promise
    expect(fifth.status).toBe(503)
    gate.resolve(); expect((await Promise.all(first.map(result => result.promise))).every(result => result.status === 200)).toBe(true)
    expect(maximum).toBe(1)
  })

  it('bounds waiting metadata requests and coalesces their provider catalog operation', async () => {
    const f = fixture(100), mount = await url(f.fs), gate = deferred<DeviceFsCatalog>(), entered = deferred<void>()
    let catalogs = 0
    f.store.catalog = async () => { catalogs++; entered.resolve(); return gate.promise }
    const pending = Array.from({ length: 16 }, () => send(mount, 'HEAD', 'closed.hda'))
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 30))
    expect((await send(mount, 'HEAD', 'closed.hda').promise).status).toBe(503)
    gate.resolve(f.catalog)
    expect((await Promise.all(pending.map(item => item.promise))).every(reply => reply.status === 200)).toBe(true)
    expect(catalogs).toBe(1)
    expect(f.reads).toHaveLength(0)
  })

  it('rejects partial/oversized catalogs without using cached bytes', async () => {
    const f = fixture(100), mount = await url(f.fs)
    await send(mount, 'GET', 'closed.hda').promise
    f.catalog.complete = false
    expect((await send(mount, 'GET', 'closed.hda').promise).status).toBe(503)
    expect(f.reads).toHaveLength(1)
    f.catalog.complete = true
    f.catalog.files = Array.from({ length: 4097 }, (_, n) => ({ ...f.file, name: `f${n}.hda` }))
    expect((await send(mount, 'HEAD', 'closed.hda').promise).status).toBe(503)
    expect(f.reads).toHaveLength(1)
  })

  it('fresh signature replacement invalidates cached bytes; session change remains failclosed until remount', async () => {
    const f = fixture(100), mount = await url(f.fs)
    expect((await send(mount, 'GET', 'closed.hda').promise).body).toEqual(f.data)
    f.file.signature = 'stable-two'; f.data[0] ^= 1
    expect((await send(mount, 'GET', 'closed.hda').promise).body).toEqual(f.data)
    expect(f.reads).toHaveLength(2)
    f.catalog.sessionId = 'new-session'
    expect((await send(mount, 'HEAD', 'closed.hda').promise).status).toBe(503)
    expect(f.fs.status().cachedBytes).toBe(0)
    f.catalog.sessionId = 'fixture-session'
    expect((await send(mount, 'HEAD', 'closed.hda').promise).status).toBe(503)
    await f.fs.stop(); const remount = await url(f.fs)
    expect((await send(remount, 'HEAD', 'closed.hda').promise).status).toBe(200)
    expect((await send(mount, 'HEAD', 'closed.hda').promise.catch(() => ({ status: 0 }))).status).not.toBe(200)
  })

  it('stop during a pending start cannot revive old catalog/server state', async () => {
    const f = fixture(100), gate = deferred<DeviceFsCatalog>()
    let calls = 0
    f.store.catalog = async () => ++calls === 1 ? gate.promise : f.catalog
    const first = f.fs.start().then(() => 'started', () => 'cancelled')
    await turn(); await f.fs.stop()
    expect(f.fs.status().running).toBe(false)
    const second = f.fs.start()
    gate.resolve(f.catalog)
    expect(await first).toBe('cancelled')
    const status = await second
    expect(status.running).toBe(true)
    expect((await send(status.mountUrl!, 'HEAD', 'closed.hda').promise).status).toBe(200)
    expect(calls).toBe(3)
  })

  it('late aborted reads after stop cannot populate a remounted cache', async () => {
    const f = fixture(100), gate = deferred<void>(), entered = deferred<void>(), mount = await url(f.fs)
    f.store.read = async (_file, offset, count) => { entered.resolve(); await gate.promise; return f.data.subarray(offset, offset + count) }
    const request = send(mount, 'GET', 'closed.hda')
    await entered.promise
    const stopped = f.fs.stop(); gate.resolve(); await stopped; await request.promise.catch(() => undefined)
    expect(f.fs.status().cachedBytes).toBe(0); expect(f.fs.status().files).toBe(0)
    const status = await f.fs.start()
    expect(status.cachedBytes).toBe(0)
  })

  it('trace is capped/sanitized and contains neither file names nor private capability', async () => {
    const f = fixture(100), mount = await url(f.fs), prefix = new URL(mount).pathname
    for (let n = 0; n < 70; n++) await send(mount, 'HEAD', 'closed.hda').promise
    const trace = f.fs.telemetry(), encoded = JSON.stringify(trace)
    expect(trace).toHaveLength(64)
    expect(trace.every(row => row.method === 'HEAD' && row.pathKind === 'capability' && row.status === 200)).toBe(true)
    expect(encoded.includes(prefix)).toBe(false); expect(encoded.includes('closed.hda')).toBe(false)
    expect(createHash('sha256').update(encoded).digest('hex')).toHaveLength(64)
  })
})
