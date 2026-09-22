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

export const VERSION = '0.1.0'
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

/** True when the request came from this machine. */
export function isLocalRequest(req) {
  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function controlPage(state, pairingCode) {
  const rows = [
    ['State', state.publicState()],
    ['Version', VERSION],
    pairingCode ? ['Pairing code', pairingCode] : null,
  ].filter(Boolean)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HiDock Model Host</title>
<style>
 :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
 body { margin: 0; padding: 2rem 1rem; display: grid; justify-items: center; }
 main { width: min(34rem, 100%); }
 h1 { font-size: 1.25rem; margin: 0 0 1rem; }
 table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
 th, td { text-align: left; padding: .5rem 0; border-bottom: 1px solid #8884; }
 form { display: flex; gap: .5rem; flex-wrap: wrap; }
 button { padding: .6rem 1rem; font: inherit; cursor: pointer; }
</style></head>
<body><main>
<h1>HiDock Model Host</h1>
<table><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</tbody></table>
<form method="post" action="/control">
 <button name="action" value="start">Start</button>
 <button name="action" value="pause">Pause</button>
 <button name="action" value="stop">Stop</button>
 <button name="action" value="pair">Show a pairing code</button>
</form>
</main></body></html>`
}

/**
 * @param {object} deps
 * @param {HostState} deps.state
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
        sendJson(res, 200, {
          version: VERSION,
          state: deps.state.publicState(),
          reason: deps.state.reason || undefined,
          ...deps.capabilities(),
        })
        return
      }

      if (req.method === 'POST' && path === '/pair') {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
        const result = deps.pairing.redeem(body.code)
        if (!result.ok) {
          sendJson(res, 403, { error: result.reason })
          return
        }
        sendJson(res, 200, { token: result.token, version: VERSION })
        return
      }

      // The control page and its form are for the person at this machine only.
      if (path === '/' || path === '/control') {
        if (!isLocalRequest(req)) {
          sendJson(res, 403, { error: 'The control page only answers on this machine.' })
          return
        }
        if (req.method === 'POST' && path === '/control') {
          const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'))
          const action = form.get('action')
          if (action === 'pair') {
            deps.pairing.openPairing()
          } else {
            await deps.state.apply(action)
          }
          res.writeHead(303, { location: '/' })
          res.end()
          return
        }
        const page = controlPage(deps.state, deps.pairing.pending?.code)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(page),
        })
        res.end(page)
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
        if (!deps.state.canAdmit()) {
          // One heavy job at a time, so the client retries or goes local
          // instead of queueing behind something it cannot see.
          sendJson(res, 429, { error: 'The host is already running a job.', state: 'busy' })
          return
        }

        const audio = await readBody(req)
        if (audio.length === 0) {
          sendJson(res, 400, { error: 'no audio in the request body' })
          return
        }

        const controller = new AbortController()
        deps.state.activeJob = controller
        // A client that hangs up has no use for the answer, and the job would
        // otherwise hold the single heavy lane until its timeout — an hour of
        // the host refusing everyone for a recording nobody is waiting for.
        const onDisconnect = () => controller.abort()
        res.on?.('close', onDisconnect)
        try {
          const result = await diarize(audio, {
            ...deps.jobOptions(),
            extension: url.searchParams.get('ext') || '.wav',
            signal: controller.signal,
          })
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
