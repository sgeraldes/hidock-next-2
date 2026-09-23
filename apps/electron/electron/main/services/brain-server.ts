/**
 * The brain's HTTP API: a small, read-only door agents knock on.
 *
 * It replaces the Chrome DevTools port the old bridge used, which had no
 * authentication, executed arbitrary JavaScript in the renderer, accepted any
 * process on the machine and lit a red banner in the app. This listens on
 * 127.0.0.1 only, answers a fixed set of questions, and requires on every
 * request:
 *
 * - `Authorization: Bearer <token>`, compared in constant time. The token is in
 *   the lock file beside config.json, so being able to read it is being the
 *   owner's account — the same boundary the database file already has.
 * - a `Host` header naming this loopback port. A web page can resolve its own
 *   hostname to 127.0.0.1 (DNS rebinding) and reach a loopback server, but its
 *   requests still carry its own hostname, so they are refused here. The same
 *   check guards apps/model-host.
 *
 * The same server runs inside the app and inside the headless `--brain-only`
 * process; only `kind` and the optional `recordingNow` differ.
 *
 * Spec: docs/superpowers/specs/2026-09-22-brain-service-design.md
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { timingSafeEqual } from 'crypto'
import type { BrainKind } from './brain-lock'

export interface BrainQueries {
  meetingsSince(since: string): unknown[]
  pendingActionablesSince(since: string): unknown[]
  actionableById(id: string): unknown
  knowledgeByIds(ids: string[]): unknown[]
  knowledgeById(id: string): unknown
  meetingRecordings(meetingId: string): unknown[]
  transcriptForRecording(recordingId: string): unknown
  recordingById(recordingId: string): unknown
  recordingsByFilenamePrefix(prefix: string): unknown[]
}

export interface BrainServerOptions {
  kind: BrainKind
  token: string
  instanceId: string
  queries: BrainQueries
  /** Called on every accepted request; the headless process uses it to stay alive. */
  onRequest?: () => void
  /** Headless only: asked to finish and exit because the app has taken over. */
  onStepDown?: () => void
  /** App only: what the device is recording right now. Absent in the headless process. */
  recordingNow?: () => unknown
  /** Fixed port for tests; 0 (the default) lets the OS choose. */
  port?: number
}

export interface RunningBrainServer {
  port: number
  /** Stop accepting, let requests already in flight finish, then resolve. */
  close(): Promise<void>
}

const ROUTES = [
  'GET /health',
  'GET /capabilities',
  'GET /meetings?since=<iso>',
  'GET /meetings/<id>/recordings',
  'GET /actionables?since=<iso>&status=pending',
  'GET /actionables/<id>',
  'GET /knowledge?ids=<id,id>',
  'GET /knowledge/<id>',
  'GET /transcripts/<recordingId>',
  'GET /recordings/<id>',
  'GET /recordings?filenamePrefix=<prefix>',
  'GET /recording-now',
  'POST /step-down',
]

/** Constant-time compare that does not leak length through an early return. */
export function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** True when the Host header names this loopback server and nothing else. */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  const value = host.toLowerCase()
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

/** A date-like `since` bound: an ISO date or timestamp, nothing else. */
function sinceParam(url: URL): string | null {
  const since = url.searchParams.get('since') ?? ''
  return /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(since) ? since : null
}

export function startBrainServer(options: BrainServerOptions): Promise<RunningBrainServer> {
  const startedAt = Date.now()
  let port = 0

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isLoopbackHost(req.headers.host, port)) return send(res, 403, { error: 'wrong host' })
    if (!tokensMatch(bearer(req), options.token)) return send(res, 401, { error: 'missing or wrong token' })
    options.onRequest?.()

    // Parsing throws on a bad escape (`%E0`) or an absolute-form request line
    // with a broken host. Uncaught in the main process, that is Electron's modal
    // error box, so it answers 400 here instead.
    let url: URL
    let parts: string[]
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
    } catch {
      return send(res, 400, { error: 'malformed request path' })
    }
    const method = req.method ?? 'GET'
    const q = options.queries

    try {
      if (method === 'POST' && url.pathname === '/step-down') {
        if (options.kind !== 'service' || !options.onStepDown) return send(res, 409, { error: 'the app does not step down' })
        send(res, 202, { stepping: 'down' })
        options.onStepDown()
        return
      }
      if (method !== 'GET') return send(res, 405, { error: 'read-only' })

      if (url.pathname === '/health') {
        return send(res, 200, {
          kind: options.kind,
          instanceId: options.instanceId,
          pid: process.pid,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        })
      }
      if (url.pathname === '/capabilities') {
        return send(res, 200, {
          kind: options.kind,
          routes: ROUTES.filter((r) => options.kind === 'service' || r !== 'POST /step-down'),
          recordingNow: Boolean(options.recordingNow),
        })
      }
      if (parts[0] === 'meetings' && parts.length === 1) {
        const since = sinceParam(url)
        if (!since) return send(res, 400, { error: 'since must be an ISO date, e.g. 2026-09-15' })
        return send(res, 200, q.meetingsSince(since))
      }
      if (parts[0] === 'meetings' && parts.length === 3 && parts[2] === 'recordings') {
        return send(res, 200, q.meetingRecordings(parts[1]))
      }
      if (parts[0] === 'actionables' && parts.length === 1) {
        const since = sinceParam(url)
        if (!since) return send(res, 400, { error: 'since must be an ISO date, e.g. 2026-09-15' })
        if ((url.searchParams.get('status') ?? 'pending') !== 'pending') {
          return send(res, 400, { error: 'only status=pending is served' })
        }
        return send(res, 200, q.pendingActionablesSince(since))
      }
      if (parts[0] === 'actionables' && parts.length === 2) {
        const found = q.actionableById(parts[1])
        return found ? send(res, 200, found) : send(res, 404, { error: 'not found' })
      }
      if (parts[0] === 'knowledge' && parts.length === 1) {
        const ids = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (ids.length === 0) return send(res, 400, { error: 'ids is required' })
        if (ids.length > 500) return send(res, 400, { error: 'at most 500 ids per request' })
        return send(res, 200, q.knowledgeByIds(ids))
      }
      if (parts[0] === 'knowledge' && parts.length === 2) {
        const found = q.knowledgeById(parts[1])
        return found ? send(res, 200, found) : send(res, 404, { error: 'not found' })
      }
      if (parts[0] === 'recordings' && parts.length === 1) {
        const prefix = url.searchParams.get('filenamePrefix') ?? ''
        if (prefix.length < 3) return send(res, 400, { error: 'filenamePrefix of at least 3 characters is required' })
        return send(res, 200, q.recordingsByFilenamePrefix(prefix))
      }
      if (parts[0] === 'recordings' && parts.length === 2) {
        const found = q.recordingById(parts[1])
        return found ? send(res, 200, found) : send(res, 404, { error: 'not found' })
      }
      if (parts[0] === 'transcripts' && parts.length === 2) {
        const found = q.transcriptForRecording(parts[1])
        return found ? send(res, 200, found) : send(res, 404, { error: 'not found' })
      }
      if (url.pathname === '/recording-now') {
        if (!options.recordingNow) {
          return send(res, 503, {
            error: 'the device state is only known while the HiDock app is open',
          })
        }
        return send(res, 200, options.recordingNow())
      }
      return send(res, 404, { error: 'unknown route', routes: ROUTES })
    } catch (error) {
      console.error('[Brain] request failed:', error)
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  const server: Server = createServer(handle)
  // No keep-alive: a lingering idle socket would hold close() open, and every
  // client here makes one request and leaves.
  server.keepAliveTimeout = 1

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeIdleConnections?.()
          }),
      })
    })
  })
}
