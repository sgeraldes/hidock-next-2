import { ASR_MODELS } from './asr.mjs'
import { attachRealtimeGateway } from './realtime-gateway.mjs'
import { validateSemanticRequest, SEMANTIC_MODEL } from './semantic-embeddings.mjs'
/**
 * The host's HTTP surface. Three routes for the client, one page for the person
 * sitting at the machine.
 *
 * Everything here is small except one thing: the audio body of a diarization
 * job. So the body limit is the only real defence against a client filling the
 * host's disk, and it is checked before a single byte is buffered.
 */

import { createServer } from 'http'
import { readFileSync } from 'fs'
import { createServer as createSecureServer } from 'https'
import { READY, HostState } from './state.mjs'
import { PairingStore } from './auth.mjs'
import { runDiarization } from './diarize.mjs'
import { checkDecisionRequest } from './decide.mjs'
import { HostTelemetry } from './telemetry.mjs'
import { dashboardHtml, dashboardScript } from './dashboard.mjs'

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
/** A decision request is a state and its questions; a long meeting transcript fits well under this. */
export const MAX_DECISION_BYTES = 1024 * 1024
/** Two hours of 16 kHz mono WAV is about 230 MB; round up and stop there. */
export const MAX_AUDIO_BYTES = 512 * 1024 * 1024

/** Read a request body, refusing anything over the limit without buffering it. */
export function readBody(req, limit = MAX_AUDIO_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('audio is larger than this host accepts'), { status: 413 }))
      return
    }
    const chunks = []
    let total = 0
    // Destroying the request makes it emit its own error, and that error would
    // otherwise replace the 413 with "socket hang up" — a true statement that
    // tells the client nothing about what it did wrong.
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        // A missing or lying Content-Length gets caught here instead.
        settle(reject, Object.assign(new Error('audio is larger than this host accepts'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => settle(reject, error))
    req.on('end', () => settle(resolve, Buffer.concat(chunks)))
  })
}

/** A small JSON body; a body that is not JSON is the caller's mistake, so 400. */
async function readJsonBody(req, limit = 4096) {
  const text = (await readBody(req, limit)).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('the body is not JSON'), { status: 400 })
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The control page is the only thing meant to load this in a browser.
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * The container extension a client asked for, or nothing.
 *
 * This value reaches a filename, and the request body is whatever the caller
 * sent, so an unchecked `ext` is an arbitrary file write: `?ext=../../../..`
 * plus a batch-file body lands the caller's bytes in the Startup folder, and
 * the job's own cleanup does not remove it because it is outside the temp
 * directory it deletes. Only a short plain extension survives this.
 */
export function safeExtension(raw) {
  const value = String(raw ?? '')
  return /^\.[a-z0-9]{1,8}$/i.test(value) ? value.toLowerCase() : ''
}

/**
 * The voice models a client may ask for. The client pins the model its voice
 * library was built with, so a host configured for another one still answers
 * in the library's space. Anything else is refused rather than downloaded.
 */
export const PINNABLE_MODELS = new Set([
  'pyannote/speaker-diarization-3.1',
  'pyannote/speaker-diarization-community-1',
])
const NATIVE_DIARIZATION_MODEL = 'nvidia/Nemotron-3-Diarization'

export function pinnedModel(raw) {
  const value = String(raw ?? '')
  return PINNABLE_MODELS.has(value) ? value : ''
}

/**
 * True when the request came from this machine AND addressed it as this
 * machine.
 *
 * The socket check alone is beaten by DNS rebinding: a page in a browser ON
 * this machine can be pointed at an attacker domain that resolves to
 * 127.0.0.1, and its POST then arrives from loopback like any other. The Host
 * header is what that attack cannot forge, so it is checked too.
 */
export function isLocalRequest(req) {
  const address = req.socket?.remoteAddress || ''
  const fromLoopback =
    address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!fromLoopback) return false

  const host = String(req.headers?.host ?? '').toLowerCase()
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

/** The step-aside positions HiDock may set. */
export const STEP_ASIDE = new Set(['any-use', 'games', 'never'])

/** What the tray icon and a paired HiDock are told about pairing. */
function pairingReport(pairing) {
  const auto = pairing.automatic()
  return { automatic: auto.open, remainingMs: auto.remainingMs, cancelled: auto.cancelled, paired: auto.paired }
}

/**
 * @param {object} deps
 * @param {HostState} deps.state
 * @param {import('./host-setup.mjs').HostSetup} [deps.setup] the token and the model check
 * @param {{ get: () => string, set: (value: string) => void }} [deps.stepAside]
 * @param {PairingStore} deps.pairing
 * @param {() => object} deps.jobOptions options for runDiarization
 * @param {() => object} deps.capabilities what /health reports
 * @param {typeof runDiarization} [deps.diarize] injected for tests
 */
export function createHandler(deps) {
  let preparingAsr = false
  const diarize = deps.diarize || runDiarization
  const telemetry = deps.telemetry || new HostTelemetry({ hasGpu: () => Boolean(deps.capabilities().gpu) })
  if (deps.jobs) deps.jobs.telemetry = telemetry
  deps.onTelemetry?.(telemetry)

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://host')
    const path = url.pathname

    try {
      if (preparingAsr && req.method !== 'GET') {
        sendJson(res, 409, { error: 'Runtime maintenance is in progress; reconnect after it finishes' }); return
      }
      if (path === '/v1/health' || path === '/v1/capabilities' || path === '/v1/embeddings' || path === '/v1/generate' || path === '/v1/jobs' || path.startsWith('/v1/jobs/')) {
        if (!req.socket.encrypted && !isLocalRequest(req)) {
          sendJson(res, 426, { error: 'TLS is required outside loopback' }); return
        }
        if (!deps.pairing.accepts(req.headers.authorization)) {
          sendJson(res, 401, { error: 'Pair this client first' }); return
        }
        if (req.method === 'GET' && path === '/v1/health') {
          sendJson(res, 200, { protocolVersion: 1, version: VERSION, state: deps.state.publicState() }); return
        }
        if (req.method === 'GET' && path === '/v1/capabilities') {
          const capabilities = deps.capabilities()
          sendJson(res, 200, { protocolVersion: 1, version: VERSION, ...capabilities,
            stages: [...(capabilities.capabilities.includes('diarize') || capabilities.diarizationModels?.length ? ['diarization'] : []),
              ...(capabilities.capabilities.includes('vad') ? ['vad'] : []),
              ...((capabilities.asrModels || []).length ? ['transcription'] : [])],
            models: [...(capabilities.diarizationModels ?? (capabilities.capabilities.includes('diarize') ? [...PINNABLE_MODELS] : [])),
              ...(capabilities.capabilities.includes('vad') ? ['energy-vad-safety-v1'] : []),
              ...(capabilities.asrModels || []).filter(model => ASR_MODELS.has(model))],
            defaultAsrModel: capabilities.asrModels?.[0] || null,
            retention: { audio: 'until job ends', resultSeconds: 86400 } }); return
        }
        if (path === '/v1/generate') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'Use POST' }); return }
          const profile = await deps.generation?.profile()
          if (!profile?.ready) { sendJson(res, 503, { error: 'Managed generation is not validated' }); return }
          const body = await readJsonBody(req, 80000)
          if (!body || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64 ||
              body.messages.some(item => !item || !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string') ||
              Buffer.byteLength(JSON.stringify(body.messages)) > 65536 ||
              !Number.isInteger(body.maxOutputTokens) || body.maxOutputTokens < 1 || body.maxOutputTokens > 2048 ||
              (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) ||
              (body.jsonMode !== undefined && typeof body.jsonMode !== 'boolean')) {
            sendJson(res, 400, { error: 'Invalid generation request or quota' }); return
          }
          if (body.expectedModelVersion !== profile.modelVersion) { sendJson(res, 409, { error: 'Generation model changed; select it again' }); return }
          if (!deps.state.canAdmit() || telemetry.snapshot().activeJobs.length) { sendJson(res, 409, { error: 'Host is busy or paused' }); return }
          const controller = new AbortController()
          deps.state.activeJob = controller
          const jobId = telemetry.start('generation', profile.model)
          const abort = () => controller.abort()
          req.once('aborted', abort)
          const disconnected = () => { if (!res.writableFinished) abort() }
          res.once('close', disconnected)
          try {
            const result = await deps.generation.run(body, { signal: controller.signal })
            if (result.modelVersion !== profile.modelVersion || result.model !== profile.model || typeof result.text !== 'string') throw Error('Generation result changed identity')
            telemetry.finish(jobId, 'completed', result.device, result)
            if (!controller.signal.aborted) sendJson(res, 200, result)
          } catch (error) {
            telemetry.finish(jobId, controller.signal.aborted ? 'cancelled' : 'failed')
            if (!controller.signal.aborted) sendJson(res, 502, { error: 'Managed generation failed; no fallback' })
          } finally {
            req.removeListener('aborted', abort); res.removeListener('close', disconnected)
            if (deps.state.activeJob === controller) deps.state.activeJob = null
          }
          return
        }
        if (path === '/v1/embeddings') {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return }
          const profile = deps.semantic?.profile()
          if (!profile?.ready) { sendJson(res, 503, { error: 'Semantic embedding runtime is not validated' }); return }
          const raw = await readJsonBody(req, 262144)
          let request
          try { request = validateSemanticRequest(raw) }
          catch { sendJson(res, 400, { error: 'Invalid or oversized semantic embedding request' }); return }
          if (raw.expectedSpaceId !== profile.spaceId) { sendJson(res, 409, { error: 'Semantic space changed; explicitly bind the current model before indexing' }); return }
          if (!deps.state.canAdmit()) { sendJson(res, 409, { error: 'The host is not available for embedding work' }); return }
          const controller = new AbortController()
          deps.state.activeJob = controller
          const jobId = telemetry.start('embeddings', SEMANTIC_MODEL)
          let finished = false
          const abort = () => { if (!finished) controller.abort() }
          req.once('aborted', abort); res.once('close', abort)
          try {
            const result = await deps.semantic.run(request, { signal: controller.signal })
            if (controller.signal.aborted) throw new Error('Semantic embedding request cancelled')
            if (result.spaceId !== profile.spaceId) throw new Error('Semantic space changed during embedding')
            telemetry.finish(jobId, 'completed', result.device, result)
            finished = true
            sendJson(res, 200, result)
          } catch (error) {
            telemetry.finish(jobId, controller.signal.aborted ? 'cancelled' : 'failed')
            throw error
          } finally {
            finished = true
            req.off('aborted', abort); res.off('close', abort)
            if (deps.state.activeJob === controller) deps.state.activeJob = null
          }
          return
        }
        if (!deps.jobs) { sendJson(res, 503, { error: 'Durable jobs are not initialized' }); return }
        if (req.method === 'POST' && path === '/v1/jobs') {
          const request = await readJsonBody(req)
          const vad = request.stage === 'vad' && request.model === 'energy-vad-safety-v1'
          const diarization = request.stage === 'diarization' && (pinnedModel(request.model) || request.model === NATIVE_DIARIZATION_MODEL)
          const asr = request.stage === 'transcription' && ASR_MODELS.has(request.model)
          if (!vad && !diarization && !asr) { sendJson(res, 400, { error: 'Unsupported stage/model' }); return }
          if (request.model === NATIVE_DIARIZATION_MODEL ? !deps.capabilities().diarizationModels?.includes(request.model) : asr ? !deps.capabilities().asrModels?.includes(request.model) :
              !deps.capabilities().capabilities.includes(vad ? 'vad' : 'diarize')) {
            sendJson(res, 503, { error: 'The requested model runtime is not ready' }); return
          }
          sendJson(res, 200, await deps.jobs.create(request, req.headers.authorization)); return
        }
        const match = /^\/v1\/jobs\/([a-f0-9-]{36})(?:\/(audio|cancel))?$/.exec(path)
        if (match) {
          if (req.method === 'GET' && !match[2]) {
            sendJson(res, 200, deps.jobs.view(deps.jobs.get(match[1], req.headers.authorization))); return
          }
          if (req.method === 'PUT' && match[2] === 'audio') {
            sendJson(res, 202, await deps.jobs.upload(match[1], req.headers.authorization, req)); return
          }
          if (req.method === 'POST' && match[2] === 'cancel') {
            sendJson(res, 200, await deps.jobs.cancel(match[1], req.headers.authorization)); return
          }
        }
        sendJson(res, 404, { error: 'No such worker route' }); return
      }
      if (req.method === 'GET' && (path === '/' || path === '/dashboard.js' || path === '/telemetry')) {
        const known = deps.pairing.accepts(req.headers.authorization) || isLocalRequest(req)
        if (!known) { sendJson(res, 401, { error: 'Open the monitor on localhost, or pair this client.' }); return }
        if (path === '/telemetry') {
          sendJson(res, 200, { ...telemetry.snapshot(), hostState: deps.state.publicState() }); return
        }
        res.writeHead(200, {
          'content-type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
          'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff', 'cache-control': 'no-store'
        })
        res.end(path === '/' ? dashboardHtml : dashboardScript)
        return
      }
      if (req.method === 'GET' && path === '/health') {
        // An unpaired stranger learns that a host exists and whether it is
        // running. The GPU model, its driver version and how many clients are
        // paired are reconnaissance, and a paired client is the only one with
        // a reason to see them.
        const known =
          deps.pairing.accepts(req.headers.authorization) || isLocalRequest(req)
        sendJson(res, 200, {
          version: VERSION,
          protocolVersion: deps.jobs ? 1 : undefined,
          state: deps.state.publicState(),
          reason: deps.state.reason || undefined,
          // How setup is going, when it steps aside and the pairing window
          // are for HiDock, which is in charge; a stranger gets none of it.
          ...(known && deps.setup ? { setup: deps.setup.report() } : {}),
          ...(known && deps.stepAside ? { stepAside: deps.stepAside.get() } : {}),
          ...(known ? { pairing: pairingReport(deps.pairing) } : {}),
          ...(known && deps.decide ? { decide: deps.decide.report() } : {}),
          ...(known ? { telemetry: telemetry.snapshot() } : {}),
          ...(known ? deps.capabilities() : { capabilities: deps.capabilities().capabilities }),
        })
        return
      }

      if (req.method === 'POST' && path === '/pair') {
        const body = await readJsonBody(req)
        const result = deps.pairing.redeem(body.code)
        if (!result.ok) {
          sendJson(res, 403, { error: result.reason })
          return
        }
        sendJson(res, 200, { token: result.token, version: VERSION })
        return
      }

      // HiDock sends its Hugging Face token; the person never types it here.
      if (req.method === 'PUT' && path === '/secrets/hf-token') {
        if (!deps.pairing.accepts(req.headers.authorization)) {
          sendJson(res, 401, { error: 'This host does not know that client. Pair it first.' })
          return
        }
        if (!deps.setup) throw Object.assign(new Error('this host takes no token'), { status: 404 })
        const body = await readJsonBody(req)
        const setup = await deps.setup.receiveToken(body.token)
        sendJson(res, 202, { setup })
        return
      }

      // HiDock's only setting for the gamestation: when the tray icon steps aside.
      if (req.method === 'PUT' && path === '/settings/step-aside') {
        if (!deps.pairing.accepts(req.headers.authorization)) {
          sendJson(res, 401, { error: 'This host does not know that client. Pair it first.' })
          return
        }
        const body = await readJsonBody(req)
        if (!STEP_ASIDE.has(body.value) || !deps.stepAside) {
          sendJson(res, 400, { error: 'stepAside is any-use, games or never' })
          return
        }
        deps.stepAside.set(body.value)
        sendJson(res, 200, { stepAside: body.value })
        return
      }

      // Looking after the host from HiDock: the person is not at this machine
      // and Windows does not let the main PC read its files.
      if (['/diagnostics', '/runtime/repair', '/runtime/prepare-asr', '/runtime/prepare-diarization',
        '/runtime/prepare-semantic', '/runtime/prepare-realtime', '/runtime/prepare-generation', '/update'].includes(path)) {
        if (!deps.pairing.accepts(req.headers.authorization)) {
          sendJson(res, 401, { error: 'This host does not know that client. Pair it first.' })
          return
        }
        if (req.method === 'GET' && path === '/diagnostics' && deps.maintenance) {
          sendJson(res, 200, { version: VERSION, setup: deps.setup?.report(), ...(await deps.maintenance.diagnostics()) })
          return
        }
        if (req.method === 'POST' && ['/runtime/prepare-semantic', '/runtime/prepare-realtime', '/runtime/prepare-generation'].includes(path)) {
          if (!req.socket.encrypted && !isLocalRequest(req)) {
            sendJson(res, 426, { error: 'TLS is required outside loopback' }); return
          }
          const role = path.slice('/runtime/prepare-'.length)
          const operation = ({ semantic: deps.maintenance?.prepareSemantic, realtime: deps.maintenance?.prepareRealtime,
            generation: deps.maintenance?.prepareGeneration })[role]
          if (!operation) { sendJson(res, 503, { error: 'Preparation is unavailable' }); return }
          const body = await readJsonBody(req)
          if (Object.keys(body).length) { sendJson(res, 400, { error: 'This operation accepts no caller options' }); return }
          if (!deps.state.canAdmit() || telemetry.snapshot().activeJobs.length ||
              ['validating', 'repairing'].includes(deps.setup?.report().status)) {
            sendJson(res, 409, { error: 'Wait for active work to finish before preparation' }); return
          }
          preparingAsr = true
          await deps.state.apply('pause')
          sendJson(res, 202, { preparing: role, reconnectAfterPreparation: true })
          const apply = () => operation()
          if (res.writableFinished === false && typeof res.once === 'function') res.once('close', () => setTimeout(apply, 200))
          else setTimeout(apply, 20)
          return
        }
        if (req.method === 'POST' && ['/runtime/prepare-asr', '/runtime/prepare-diarization'].includes(path) && deps.maintenance?.prepareAsr) {
          if (!req.socket.encrypted && !isLocalRequest(req)) {
            sendJson(res, 426, { error: 'TLS is required outside loopback' }); return
          }
          const body = await readJsonBody(req)
          if (path === '/runtime/prepare-diarization' ? body.model !== NATIVE_DIARIZATION_MODEL : !ASR_MODELS.has(body.model)) {
            sendJson(res, 400, { error: 'Unsupported ASR model' }); return
          }
          if (!deps.state.canAdmit() || telemetry.snapshot().activeJobs.length ||
              ['validating', 'repairing'].includes(deps.setup?.report().status)) {
            sendJson(res, 409, { error: 'Wait for active work to finish before preparing ASR' }); return
          }
          // Reserve the lane before yielding. The tray stops this service and
          // runs the fixed preparation script, which restarts it in finally.
          preparingAsr = true
          await deps.state.apply('pause')
          sendJson(res, 202, { preparing: body.model, reconnectAfterPreparation: true })
          const apply = () => deps.maintenance.prepareAsr(body.model)
          if (res.writableFinished === false && typeof res.once === 'function') res.once('close', () => setTimeout(apply, 200))
          else setTimeout(apply, 20)
          return
        }
        if (req.method === 'POST' && path === '/runtime/repair' && deps.setup?.repair) {
          if (deps.state.activeJob || telemetry.snapshot().activeJobs.length ||
              ['validating', 'repairing'].includes(deps.setup.report().status)) {
            sendJson(res, 409, { error: 'Wait for active work to finish before repairing' }); return
          }
          preparingAsr = true
          await deps.state.apply('pause')
          // Leave the host paused; only the owner may resume after maintenance.
          void deps.setup.repair().catch(() => {}).finally(() => { preparingAsr = false })
          sendJson(res, 202, { setup: deps.setup.report() })
          return
        }
        if (req.method === 'PUT' && path === '/update' && deps.maintenance) {
          const body = await readBody(req, 200 * 1024 * 1024)
          if (preparingAsr || deps.state.activeJob || telemetry.snapshot().activeJobs.length ||
              ['validating', 'repairing'].includes(deps.setup?.report().status)) {
            sendJson(res, 409, { error: 'Wait for active work or preparation to finish before updating' }); return
          }
          // Reserve before awaiting teardown or staging; no new model may slip in.
          preparingAsr = true
          await deps.state.apply('pause')
          try { deps.maintenance.stageUpdate(body) }
          catch (error) { preparingAsr = false; throw error }
          sendJson(res, 202, { staged: true })
          // Applying ends this process; let the answer reach HiDock first. 'close' follows 'finish',
          // and also comes alone when HiDock hangs up first, which would otherwise leave it unapplied.
          const apply = () => deps.maintenance.applyUpdate()
          if (res.writableFinished === false && typeof res.once === 'function') res.once('close', () => setTimeout(apply, 200))
          else setTimeout(apply, 20)
          return
        }
        sendJson(res, 405, { error: 'not here' })
        return
      }

      // The tray icon's control, from this machine only. No page: the
      // gamestation has no settings, and the icon has its own menu.
      if (path === '/control') {
        if (!isLocalRequest(req)) {
          sendJson(res, 403, { error: 'The control only answers on this machine.' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST an action' })
          return
        }
        const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'))
        const action = form.get('action')
        if (action === 'pair-code') {
          const code = deps.pairing.openPairing()
          sendJson(res, 200, { code, pairing: pairingReport(deps.pairing) })
          return
        }
        if (action === 'pair-open') deps.pairing.resumeAutomatic()
        else if (action === 'pair-cancel') deps.pairing.cancelAutomatic()
        else if (action === 'pair-reset') deps.pairing.resetPairing()
        else if (action !== 'status') {
          sendJson(res, 400, { error: `unknown action: ${action}` })
          return
        }
        sendJson(res, 200, {
          state: deps.state.publicState(),
          setup: deps.setup?.report(),
          pairing: pairingReport(deps.pairing),
        })
        return
      }

      // Clef and Clef-Flash share model admission with audio, including resident GPU memory.
      if (path === '/v1/systemone') {
        if (!deps.pairing.accepts(req.headers.authorization)) {
          sendJson(res, 401, { error: 'This host does not know that client. Pair it first.' })
          return
        }
        if (!deps.decide) {
          sendJson(res, 404, { error: 'This host does not run decision models.' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST a decision request' })
          return
        }
        if (deps.state.state !== READY) {
          sendJson(res, 503, {
            error: deps.state.reason || 'The host is not accepting work.',
            state: deps.state.publicState(),
          })
          return
        }
        const body = await readJsonBody(req, MAX_DECISION_BYTES)
        if (deps.state.state !== READY) {
          sendJson(res, 503, { error: 'The host stopped accepting work.', state: deps.state.publicState() })
          return
        }
        const problem = checkDecisionRequest(body)
        if (problem) {
          sendJson(res, 400, { error: problem })
          return
        }
        if (!deps.state.canAdmit() || telemetry.snapshot().activeJobs.length) {
          sendJson(res, 409, { error: 'Wait for active model work to finish before decisions' }); return
        }
        const decisionController = new AbortController()
        deps.state.activeJob = decisionController
        let decisionTeardown
        const cancelDecision = () => {
          decisionController.abort()
          decisionTeardown ||= Promise.resolve(deps.decide.stop?.())
          void decisionTeardown.catch(() => {})
        }
        req.once('aborted', cancelDecision)
        const decisionDisconnected = () => { if (!res.writableFinished) cancelDecision() }
        res.once('close', decisionDisconnected)
        const decisionJobId = telemetry.start('decision', body.model)
        try {
          const result = await deps.decide.decide(body)
          telemetry.finish(decisionJobId, 'completed', result.device || null, result)
          if (!decisionController.signal.aborted) sendJson(res, 200, result)
        } catch (error) {
          telemetry.finish(decisionJobId, decisionController.signal.aborted ? 'cancelled' : 'failed')
          if (!decisionController.signal.aborted) sendJson(res, error?.status || 500, { error: error?.message || 'the decision failed', ...(error?.extra || {}) })
        } finally {
          req.removeListener('aborted', cancelDecision); res.removeListener('close', decisionDisconnected)
          if (decisionTeardown) await decisionTeardown
          if (deps.state.activeJob === decisionController) deps.state.activeJob = null
        }
        return
      }

      if (req.method === 'POST' && path === '/jobs/diarize') {
        if (!deps.pairing.accepts(req.headers.authorization)) {
          sendJson(res, 401, { error: 'This host does not know that client. Pair it first.' })
          return
        }
        if (deps.state.state !== READY) {
          sendJson(res, 503, {
            error: deps.state.reason || 'The host is not accepting work.',
            state: deps.state.publicState(),
          })
          return
        }
        if (deps.setup && !deps.setup.canDiarize()) {
          sendJson(res, 503, {
            error: 'The host has not run the voice model yet. HiDock sends it the token when it pairs.',
            setup: deps.setup.report(),
          })
          return
        }
        const requested = url.searchParams.get('model')
        const pinned = pinnedModel(requested)
        if (requested && !pinned) {
          sendJson(res, 400, { error: `this host does not run the voice model ${requested}` })
          return
        }
        if (!deps.state.canAdmit()) {
          // One heavy job at a time, so the client retries or goes local
          // instead of queueing behind something it cannot see.
          sendJson(res, 429, { error: 'The host is already running a job.', state: 'busy' })
          return
        }

        // Take the lane HERE, in the same tick as the check above.
        // Reserving it after `await readBody` left a window the length of an
        // upload: a second request reaching the check while the first was
        // still reading its body found the lane free and was admitted too, and
        // two pyannote workers then fought over the GPU.
        const controller = new AbortController()
        deps.state.activeJob = controller
        const rawRecordingId = String(req.headers['x-hidock-recording-id'] || '')
        const recordingId = /^[a-zA-Z0-9_-]{1,80}$/.test(rawRecordingId) ? rawRecordingId : null
        const hostJobId = telemetry.start('diarization', pinned || deps.jobOptions().model, recordingId)
        telemetry.phase(hostJobId, 'uploading')
        // A client that hangs up has no use for the answer, and the job would
        // otherwise hold the single heavy lane until its timeout — an hour of
        // the host refusing everyone for a recording nobody is waiting for.
        const onDisconnect = () => controller.abort()
        res.on?.('close', onDisconnect)
        try {
          const audio = await readBody(req)
          if (audio.length === 0) {
            sendJson(res, 400, { error: 'no audio in the request body' })
            return
          }
          let result
          try {
            telemetry.phase(hostJobId, 'loading / diarizing')
            const options = {
              ...deps.jobOptions(),
              // A pinned model is used alone: falling back to another model would
              // answer in a voice space the client just said it cannot use.
              ...(pinned ? { model: pinned, fallbackModel: pinned } : {}),
              extension: safeExtension(url.searchParams.get('ext')),
              signal: controller.signal,
            }
            result = await (deps.decide
              ? deps.decide.withAudio(() => diarize(audio, options), options)
              : diarize(audio, options))
          } catch (error) {
            // Cancelled by a pause or a stop: the same answer as a host that was
            // already paused, so the client runs the recording itself and the
            // person reads why.
            if (controller.signal.aborted && deps.state.state !== READY) {
              sendJson(res, 503, {
                error: deps.state.reason || 'The host stopped this job.',
                state: deps.state.publicState(),
              })
              return
            }
            throw error
          }
          telemetry.finish(hostJobId, 'completed', result.device, result)
          sendJson(res, 200, { ...result, hostJobId })
        } finally {
          telemetry.finish(hostJobId, controller.signal.aborted ? 'cancelled' : 'failed')
          res.off?.('close', onDisconnect)
          deps.state.activeJob = null
        }
        return
      }

      sendJson(res, 404, { error: 'no such route' })
    } catch (error) {
      const status = error?.status || 500
      sendJson(res, status, { error: error?.message || 'the host failed to handle that request' })
    }
  }
}

export function createHostServer(deps) {
  let telemetry
  const handler = createHandler({ ...deps, onTelemetry: value => { telemetry = value; deps.onTelemetry?.(value) } })
  const serve = deps.tls ? callback => createSecureServer(deps.tls, callback) : createServer
  const server = serve((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'the host failed to handle that request' })
    })
  })
  if (deps.realtime) attachRealtimeGateway(server, { ...deps.realtime, state: deps.state, pairing: deps.pairing, telemetry })
  server.on('close', () => { telemetry?.stop(); deps.jobs?.close() })
  return server
}
