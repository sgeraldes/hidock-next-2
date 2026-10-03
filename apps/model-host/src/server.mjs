/**
 * The host's HTTP surface. Three routes for the client, one page for the person
 * sitting at the machine.
 *
 * Everything here is small except one thing: the audio body of a diarization
 * job. So the body limit is the only real defence against a client filling the
 * host's disk, and it is checked before a single byte is buffered.
 */

import { createServer } from 'http'
import { READY, STOPPED, HostState } from './state.mjs'
import { PairingStore } from './auth.mjs'
import { runDiarization } from './diarize.mjs'

export const VERSION = '0.1.2'
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

/** Process names and paths come from the machine; nothing reaches the page raw. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The host's state as a sentence for the person at the machine. */
export function describeState(state, resumesAt) {
  const pause = state.pauseInfo()
  if (pause?.by === 'game') {
    const back = resumesAt ? ` Work resumes at ${clock(resumesAt)} if no game starts.` : ' Work resumes a few minutes after it closes.'
    return `Paused for a game: ${pause.detail}.${back}`
  }
  if (pause?.by === 'you') return 'Paused by you. Nothing new runs here until you resume.'
  const current = state.publicState()
  if (current === 'busy') return 'Working on a recording.'
  if (current === READY) return state.gameOverride ? 'Working, although a game is running: you resumed it.' : 'Ready for work.'
  return 'Stopped. Press Start to lend this GPU.'
}

function lines(values) {
  return escapeHtml(values.join('\n'))
}

function checkbox(name, checked, label) {
  return `<label><input type="checkbox" name="${name}"${checked ? ' checked' : ''}> ${label}</label>`
}

function controlPage(state, pairingCode, gameMode) {
  const settings = gameMode?.settings()
  const rows = [
    ['State', describeState(state, gameMode?.resumesAt())],
    ['Version', VERSION],
    pairingCode ? ['Pairing code', pairingCode] : null,
  ].filter(Boolean)
  const gameForm = settings
    ? `<h2>Game mode</h2>
<p>The host pauses by itself while a game runs, cancels the recording it was working on (the other computer does it instead), and resumes after the game closes.</p>
<form method="post" action="/control" class="settings">
 <input type="hidden" name="action" value="game-mode">
 ${checkbox('enabled', settings.enabled, 'Pause by itself while a game runs')}
 ${checkbox('pauseOnGameFolders', settings.pauseOnGameFolders, 'A program installed in a game folder is a game')}
 <label>Game folders, one per line<textarea name="gameFolders" rows="5">${lines(settings.gameFolders)}</textarea></label>
 <label>Programs that never count as games, one per line<textarea name="ignoreProcesses" rows="4">${lines(settings.ignoreProcesses)}</textarea></label>
 ${checkbox('pauseOnFullscreen', settings.pauseOnFullscreen, 'Any full-screen app counts as a game')}
 ${checkbox('pauseOnOtherGpuWork', settings.pauseOnOtherGpuWork, 'Another program computing on the GPU counts as a game')}
 <label>Programs that may share the GPU, one per line<textarea name="ignoreGpu" rows="2">${lines(settings.ignoreGpu)}</textarea></label>
 <label>Programs that always pause the host, one per line<textarea name="alwaysPause" rows="3">${lines(settings.alwaysPause)}</textarea></label>
 <label>Minutes after the game closes before work resumes <input type="number" name="resumeAfterMinutes" min="0" max="120" value="${settings.resumeAfterMinutes}"></label>
 <button>Save game mode</button>
</form>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HiDock Model Host</title>
<style>
 :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
 body { margin: 0; padding: 2rem 1rem; display: grid; justify-items: center; }
 main { width: min(38rem, 100%); }
 h1 { font-size: 1.25rem; margin: 0 0 1rem; }
 h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
 table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
 th, td { text-align: left; padding: .5rem 0; border-bottom: 1px solid #8884; vertical-align: top; }
 th { width: 8rem; }
 form { display: flex; gap: .5rem; flex-wrap: wrap; }
 form.settings { flex-direction: column; align-items: stretch; }
 form.settings label { display: flex; flex-direction: column; gap: .25rem; }
 form.settings label:has(input[type=checkbox]) { flex-direction: row; align-items: center; }
 textarea { font: 13px ui-monospace, monospace; }
 button { padding: .6rem 1rem; font: inherit; cursor: pointer; align-self: flex-start; }
</style></head>
<body><main>
<h1>HiDock Model Host</h1>
<table><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table>
<form method="post" action="/control">
 ${state.state === STOPPED ? '<button name="action" value="start">Start</button>' : `<button name="action" value="toggle">${state.state === READY ? 'Pause' : 'Resume'}</button>`}
 <button name="action" value="stop">Stop</button>
 <button name="action" value="pair">Show a pairing code</button>
</form>
${gameForm}
</main></body></html>`
}

/** Game mode settings from the control page's form. Unchecked boxes are absent. */
function gameModeFromForm(form) {
  const listField = (name) => (form.get(name) ?? '').split(/\r?\n/)
  return {
    enabled: form.has('enabled'),
    pauseOnGameFolders: form.has('pauseOnGameFolders'),
    pauseOnFullscreen: form.has('pauseOnFullscreen'),
    pauseOnOtherGpuWork: form.has('pauseOnOtherGpuWork'),
    resumeAfterMinutes: form.get('resumeAfterMinutes') ?? '',
    gameFolders: listField('gameFolders'),
    ignoreProcesses: listField('ignoreProcesses'),
    ignoreGpu: listField('ignoreGpu'),
    alwaysPause: listField('alwaysPause'),
  }
}

/** Who paused the host, why, and when a game pause lifts; null when working. */
function pauseReport(deps) {
  const pause = deps.state.pauseInfo()
  if (!pause) return null
  return {
    by: pause.by,
    detail: pause.detail || undefined,
    since: pause.since,
    resumesAt: pause.by === 'game' ? deps.gameMode?.resumesAt() ?? null : null,
  }
}

/**
 * @param {object} deps
 * @param {HostState} deps.state
 * @param {{ settings: () => object, save: (raw: object) => Promise<object>,
 *   resumesAt: () => number | null }} [deps.gameMode]
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
          // Which game is running is the person's business; a paired client
          // shows it to them, a stranger gets only "paused".
          ...(known ? { pause: pauseReport(deps) } : {}),
          ...(known ? deps.capabilities() : { capabilities: deps.capabilities().capabilities }),
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
          const form = new URLSearchParams((await readBody(req, 64 * 1024)).toString('utf8'))
          const action = form.get('action')
          if (action === 'pair') {
            deps.pairing.openPairing()
          } else if (action === 'game-mode') {
            if (!deps.gameMode) throw Object.assign(new Error('game mode is not available'), { status: 400 })
            await deps.gameMode.save(gameModeFromForm(form))
          } else {
            await deps.state.apply(action)
          }
          // The pause/resume shortcut asks for JSON so it can say what happened.
          // It asks with ?format=json: Windows PowerShell 5.1 refuses to set
          // an Accept header on Invoke-RestMethod.
          if (
            url.searchParams.get('format') === 'json' ||
            String(req.headers.accept || '').includes('application/json')
          ) {
            sendJson(res, 200, { state: deps.state.publicState(), pause: pauseReport(deps), text: describeState(deps.state, deps.gameMode?.resumesAt()) })
            return
          }
          res.writeHead(303, { location: '/' })
          res.end()
          return
        }
        const page = controlPage(deps.state, deps.pairing.pending?.code, deps.gameMode)
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
