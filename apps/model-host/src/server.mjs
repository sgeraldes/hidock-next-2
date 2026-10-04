/**
 * The host's HTTP surface. Three routes for the client, one page for the person
 * sitting at the machine.
 *
 * Everything here is small except one thing: the audio body of a diarization
 * job. So the body limit is the only real defence against a client filling the
 * host's disk, and it is checked before a single byte is buffered.
 */

import { createServer } from 'http'
import { READY, HostState } from './state.mjs'
import { PairingStore } from './auth.mjs'
import { runDiarization } from './diarize.mjs'

export const VERSION = '0.3.1'
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
async function readJsonBody(req) {
  const text = (await readBody(req, 4096)).toString('utf8')
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
  const diarize = deps.diarize || runDiarization

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://host')
    const path = url.pathname

    try {
      if (req.method === 'GET' && path === '/health') {
        // An unpaired stranger learns that a host exists and whether it is
        // running. The GPU model, its driver version and how many clients are
        // paired are reconnaissance, and a paired client is the only one with
        // a reason to see them.
        const known =
          deps.pairing.accepts(req.headers.authorization) || isLocalRequest(req)
        sendJson(res, 200, {
          version: VERSION,
          state: deps.state.publicState(),
          reason: deps.state.reason || undefined,
          // How setup is going, when it steps aside and the pairing window
          // are for HiDock, which is in charge; a stranger gets none of it.
          ...(known && deps.setup ? { setup: deps.setup.report() } : {}),
          ...(known && deps.stepAside ? { stepAside: deps.stepAside.get() } : {}),
          ...(known ? { pairing: pairingReport(deps.pairing) } : {}),
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
      if (path === '/diagnostics' || path === '/runtime/repair' || path === '/update') {
        if (!deps.pairing.accepts(req.headers.authorization)) {
          sendJson(res, 401, { error: 'This host does not know that client. Pair it first.' })
          return
        }
        if (req.method === 'GET' && path === '/diagnostics' && deps.maintenance) {
          sendJson(res, 200, { version: VERSION, setup: deps.setup?.report(), ...(await deps.maintenance.diagnostics()) })
          return
        }
        if (req.method === 'POST' && path === '/runtime/repair' && deps.setup?.repair) {
          // Answer now; the reinstall takes minutes and /health shows "repairing".
          void deps.setup.repair().catch(() => {})
          sendJson(res, 202, { setup: deps.setup.report() })
          return
        }
        if (req.method === 'PUT' && path === '/update' && deps.maintenance) {
          const body = await readBody(req, 200 * 1024 * 1024)
          deps.maintenance.stageUpdate(body)
          sendJson(res, 202, { staged: true })
          // Applying ends this process; let the answer reach HiDock first.
          const apply = () => deps.maintenance.applyUpdate()
          if (res.writableFinished === false && typeof res.once === 'function') res.once('finish', () => setTimeout(apply, 200))
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
            result = await diarize(audio, {
              ...deps.jobOptions(),
              // A pinned model is used alone: falling back to another model would
              // answer in a voice space the client just said it cannot use.
              ...(pinned ? { model: pinned, fallbackModel: pinned } : {}),
              extension: safeExtension(url.searchParams.get('ext')),
              signal: controller.signal,
            })
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
          sendJson(res, 200, result)
        } finally {
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
  const handler = createHandler(deps)
  return createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'the host failed to handle that request' })
    })
  })
}
