/**
 * The brain's HTTP API: authenticated reads and optional fixed lifecycle actions.
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
 * process. The app can additionally supply semantic reads and backend lifecycle
 * callbacks; the read-only host never advertises these when they are absent.
 *
 * Spec: docs/superpowers/specs/2026-09-22-brain-service-design.md
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { timingSafeEqual } from 'crypto'
import type { BrainKind } from './brain-lock'
import type { BrainScope } from './brain-agent-access'

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
  recordingsInRange?(since: string, until: string, limit: number): unknown
}

export interface BrainServerOptions {
  kind: BrainKind
  token: string
  instanceId: string
  queries: BrainQueries
  /** Optional explicit grants. Absent by default; never creates credentials. */
  authenticateAgent?: (token: string) => readonly BrainScope[] | null
  /** Called on every accepted request; the headless process uses it to stay alive. */
  onRequest?: () => void
  /** Headless only: asked to finish and exit because the app has taken over. */
  onStepDown?: () => void
  /** App only: what the device is recording right now. Absent in the headless process. */
  recordingNow?: () => unknown
  /** Existing semantic services, available without an attached window. */
  contextGraph?: {
    overview(limit: number): unknown
    search(query: string, limit: number): unknown
    provenance(entityId: string): unknown
  }
  backend?: {
    status(): unknown
    attachUi(): void
    canStop?(): boolean
    stop(): void
  }
  transcription?: {
    submit(ids: string[], provider?: string, requestId?: string): unknown
    status(ids: string[]): unknown
    cancel(id: string): void
  }
  rag?: {
    createSession(title: string): unknown
    status(): Promise<unknown>
    chat(sessionId: string, message: string, meetingId?: string): Promise<unknown>
    cancel(sessionId: string): unknown
  }
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
  'GET /context-graph?limit=<1..100>',
  'GET /context-graph/search?q=<query>&limit=<1..100>',
  'GET /context-graph/provenance/<entityId>',
  'GET /backend/status',
  'POST /backend/ui',
  'POST /backend/stop',
  'GET /recordings?since=<iso>&until=<iso>&limit=<1..100>',
  'POST /transcriptions',
  'GET /transcriptions?ids=<id,id>',
  'POST /transcriptions/<recordingId>/cancel',
  'GET /rag/status',
  'POST /rag/sessions',
  'POST /rag/chat',
  'POST /rag/<sessionId>/cancel',
]

function availableRoutes(options: BrainServerOptions): string[] {
  return ROUTES.filter((route) =>
    (options.kind === 'service' || route !== 'POST /step-down') &&
    (Boolean(options.contextGraph) || !route.includes('/context-graph')) &&
    (Boolean(options.backend) || !route.includes('/backend/')) &&
    (Boolean(options.transcription) || !route.includes('/transcriptions')) &&
    (Boolean(options.rag) || !route.includes('/rag/')) &&
    (Boolean(options.queries.recordingsInRange) || !route.includes('until=<iso>')))
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RequestError(415, 'application/json is required')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      bytes += chunk.length
      if (bytes > 16384) { failed = true; reject(new RequestError(413, 'request body exceeds 16 KiB')); return }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (failed) return
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { reject(new RequestError(400, 'invalid JSON')); return }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { reject(new RequestError(400, 'JSON object required')); return }
      resolve(body as Record<string, unknown>)
    })
  })
}

function idsParam(ids: unknown): string[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10 || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) {
    throw new RequestError(400, 'between 1 and 10 recording IDs are required')
  }
  return [...new Set(ids)] as string[]
}

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
  let ragActive = 0

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackHost(req.headers.host, port)) return send(res, 403, { error: 'wrong host' })
    const given = bearer(req)
    const owner = tokensMatch(given, options.token)
    const scopes = owner ? null : options.authenticateAgent?.(given)
    if (!owner && !scopes) return send(res, 401, { error: 'missing or wrong token' })
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
    if (!owner) {
      const scope: BrainScope = parts[0] === 'backend' || parts[0] === 'step-down' ? 'backend:control'
        : parts[0] === 'transcriptions' ? (method === 'GET' ? 'transcription:read' : 'transcription:write')
        : parts[0] === 'rag' ? (method === 'GET' ? 'rag:read' : 'rag:write')
        : parts[0] === 'context-graph' ? 'graph:read'
        : ['health', 'capabilities'].includes(parts[0]) ? 'health:read' : 'knowledge:read'
      if (!scopes?.includes(scope)) return send(res, 403, { error: 'scope not granted' })
    }

    try {
      if (options.transcription && parts[0] === 'transcriptions') {
        if (parts.length === 1 && method === 'POST') {
          const body = await jsonBody(req)
          const ids = idsParam(body.recordingIds)
          if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.requestId)) throw new RequestError(400, 'requestId (1..100 letters, digits, underscore or hyphen) required')
          if (body.provider !== undefined && !['gemini', 'local-asr', 'vibevoice'].includes(String(body.provider))) throw new RequestError(400, 'unsupported provider')
          return send(res, 202, options.transcription.submit(ids, body.provider as string | undefined, body.requestId))
        }
        if (parts.length === 1 && method === 'GET') return send(res, 200, options.transcription.status(idsParam((url.searchParams.get('ids') ?? '').split(','))))
        if (parts.length === 3 && parts[2] === 'cancel' && method === 'POST') {
          const [id] = idsParam([parts[1]])
          options.transcription.cancel(id)
          return send(res, 202, { recordingId: id, cancellationRequested: true })
        }
      }
      if (options.rag && parts[0] === 'rag') {
        if (url.pathname === '/rag/sessions' && method === 'POST') {
          const body = await jsonBody(req)
          if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw new RequestError(400, 'title (1..200 characters) required')
          return send(res, 201, options.rag.createSession(body.title.trim()))
        }
        if (url.pathname === '/rag/status' && method === 'GET') return send(res, 200, await options.rag.status())
        if (url.pathname === '/rag/chat' && method === 'POST') {
          const body = await jsonBody(req)
          if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 200 || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8000) throw new RequestError(400, 'sessionId and message (1..8000 characters) required')
          if (body.meetingId !== undefined && (typeof body.meetingId !== 'string' || !body.meetingId || body.meetingId.length > 200)) throw new RequestError(400, 'invalid meetingId')
          if (ragActive >= 2) throw new RequestError(409, 'two RAG requests are already active')
          ragActive++
          try { return send(res, 200, await options.rag.chat(body.sessionId, body.message, body.meetingId as string | undefined)) }
          finally { ragActive-- }
        }
        if (parts.length === 3 && parts[2] === 'cancel' && method === 'POST') {
          if (!parts[1] || parts[1].length > 200) throw new RequestError(400, 'invalid sessionId')
          return send(res, 202, { cancelled: options.rag.cancel(parts[1]) })
        }
      }
      if (method === 'POST' && options.backend && url.pathname === '/backend/ui') {
        options.backend.attachUi()
        return send(res, 202, { ui: 'requested' })
      }
      if (method === 'POST' && options.backend && url.pathname === '/backend/stop') {
        if (ragActive > 0 || options.backend.canStop?.() === false) throw new RequestError(409, 'active work must finish or be cancelled before stopping')
        send(res, 202, { backend: 'stopping' })
        // Let the response leave before the lifecycle shuts down the socket.
        setImmediate(() => options.backend?.stop())
        return
      }
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
          routes: availableRoutes(options),
          recordingNow: Boolean(options.recordingNow),
        })
      }
      if (url.pathname === '/backend/status' && options.backend) {
        return send(res, 200, options.backend.status())
      }
      if (parts[0] === 'context-graph' && options.contextGraph) {
        const rawLimit = url.searchParams.get('limit') ?? '12'
        if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
          return send(res, 400, { error: 'limit must be an integer between 1 and 100' })
        }
        const limit = Number(rawLimit)
        if (parts.length === 1) return send(res, 200, options.contextGraph.overview(limit))
        if (parts.length === 2 && parts[1] === 'search') {
          const query = (url.searchParams.get('q') ?? '').trim()
          if (!query || query.length > 500) return send(res, 400, { error: 'q must contain 1 to 500 characters' })
          return send(res, 200, options.contextGraph.search(query, limit))
        }
        if (parts.length === 3 && parts[1] === 'provenance') {
          return send(res, 200, options.contextGraph.provenance(parts[2]))
        }
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
        if (options.queries.recordingsInRange && url.searchParams.has('since')) {
          const since = url.searchParams.get('since') ?? ''
          const until = url.searchParams.get('until') ?? ''
          const limit = Number(url.searchParams.get('limit') ?? '50')
          if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) || !/Z$|[+-]\d\d:\d\d$/.test(since) || !/Z$|[+-]\d\d:\d\d$/.test(until) || Date.parse(until) <= Date.parse(since) || Date.parse(until) - Date.parse(since) > 31 * 86400000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new RequestError(400, 'ISO timezone bounds (maximum 31 days) and limit 1..100 required')
          return send(res, 200, q.recordingsInRange!(new Date(since).toISOString(), new Date(until).toISOString(), limit))
        }
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
      return send(res, 404, { error: 'unknown route', routes: availableRoutes(options) })
    } catch (error) {
      if (error instanceof RequestError) return send(res, error.status, { error: error.message })
      console.error('[Brain] request failed:', error)
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  const server: Server = createServer(handle)
  // No keep-alive: a lingering idle socket would hold close() open, and every
  // client here makes one request and leaves.
  server.keepAliveTimeout = 1
  server.requestTimeout = 15000
  server.headersTimeout = 10000

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
