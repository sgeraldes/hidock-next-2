import { describe, it, expect, beforeEach } from 'vitest'
import { createHandler } from '../src/server.mjs'
import { HostState, PAUSED, READY } from '../src/state.mjs'
import { PairingStore } from '../src/auth.mjs'
import { normalizeGameMode } from '../src/game-mode.mjs'
import { request, response } from './helpers.mjs'

const RESULT = { model: 'm', modelVersion: '1', device: 'cuda', segments: [], speakers: [] }

function makeDeps(overrides = {}) {
  const state = new HostState({ onLeaveReady: async () => state.activeJob?.abort() })
  const pairing = new PairingStore()
  let settings = normalizeGameMode({})
  const saved = []
  return {
    state,
    pairing,
    saved,
    capabilities: () => ({ capabilities: ['diarize'], gpu: null, acceleration: 'cuda', paired: pairing.tokens.size }),
    jobOptions: () => ({}),
    diarize: overrides.diarize || (async () => RESULT),
    gameMode: {
      settings: () => settings,
      save: async (raw) => {
        settings = normalizeGameMode(raw)
        saved.push(settings)
        return settings
      },
      resumesAt: () => overrides.resumesAt ?? null,
    },
  }
}

const form = (fields) => new URLSearchParams(fields).toString()

describe('game mode on the wire', () => {
  let deps
  let token
  beforeEach(async () => {
    deps = makeDeps()
    token = deps.pairing.redeem(deps.pairing.openPairing()).token
    await deps.state.apply('start')
  })

  it('the control form pauses and resumes with one button', async () => {
    const handle = createHandler(deps)
    await handle(request({ method: 'POST', url: '/control', body: form({ action: 'toggle' }) }), response())
    expect(deps.state.state).toBe(PAUSED)
    await handle(request({ method: 'POST', url: '/control', body: form({ action: 'toggle' }) }), response())
    expect(deps.state.state).toBe(READY)
  })

  it('answers the shortcut in JSON, with who paused it', async () => {
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/control', headers: { accept: 'application/json' }, body: form({ action: 'toggle' }) }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ state: 'paused', pause: { by: 'you' } })
  })

  it('tells a paired client a game paused it, which one, and when it comes back', async () => {
    deps = makeDeps({ resumesAt: 1_700_000_300_000 })
    token = deps.pairing.redeem(deps.pairing.openPairing()).token
    await deps.state.apply('start')
    await deps.state.gamePause('eldenring.exe is running')
    const res = response()
    await createHandler(deps)(request({ url: '/health', headers: { authorization: `Bearer ${token}` }, local: false }), res)
    const body = JSON.parse(res.body)
    expect(body.state).toBe('paused')
    expect(body.pause).toMatchObject({ by: 'game', detail: 'eldenring.exe is running', resumesAt: 1_700_000_300_000 })
  })

  it('does not tell a stranger which game is running', async () => {
    await deps.state.gamePause('eldenring.exe is running')
    const res = response()
    await createHandler(deps)(request({ url: '/health', local: false }), res)
    expect(res.body).not.toMatch(/eldenring/)
    expect(JSON.parse(res.body).state).toBe('paused')
  })

  it('a pause during a job cancels it and answers 503, so the client runs it locally', async () => {
    let started
    const running = new Promise((resolve) => (started = resolve))
    deps.diarize = async (_audio, options) => {
      started()
      await new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('diarization cancelled')))
      )
    }
    const res = response()
    const job = createHandler(deps)(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'audio', local: false }),
      res
    )
    await running
    await deps.state.gamePause('eldenring.exe is running')
    await job
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toMatch(/game/i)
    expect(deps.state.activeJob).toBeNull()
  })

  it('refuses new work while a game runs', async () => {
    await deps.state.gamePause('eldenring.exe is running')
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'audio', local: false }),
      res
    )
    expect(res.statusCode).toBe(503)
  })

  it('saves game mode settings from the control page', async () => {
    const res = response()
    await createHandler(deps)(
      request({
        method: 'POST',
        url: '/control',
        body: form({
          action: 'game-mode',
          enabled: 'on',
          pauseOnGameFolders: 'on',
          resumeAfterMinutes: '10',
          alwaysPause: 'Blender.exe\r\nobs64.exe\r\n',
          gameFolders: 'steamapps\\common',
          ignoreProcesses: '',
          ignoreGpu: 'ollama.exe',
        }),
      }),
      res
    )
    expect(res.statusCode).toBe(303)
    expect(deps.saved.at(-1)).toMatchObject({
      enabled: true,
      pauseOnGameFolders: true,
      pauseOnFullscreen: false,
      pauseOnOtherGpuWork: false,
      resumeAfterMinutes: 10,
      alwaysPause: ['Blender.exe', 'obs64.exe'],
      gameFolders: ['steamapps\\common'],
      ignoreProcesses: [],
      ignoreGpu: ['ollama.exe'],
    })
  })

  it('never takes game mode settings from the network', async () => {
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/control', body: form({ action: 'game-mode' }), local: false }),
      res
    )
    expect(res.statusCode).toBe(403)
    expect(deps.saved).toEqual([])
  })

  it('the control page says in words what the host is doing and shows the settings', async () => {
    await deps.state.gamePause('eldenring.exe is running')
    const res = response()
    await createHandler(deps)(request({ url: '/' }), res)
    expect(res.body).toMatch(/Paused for a game: eldenring\.exe is running/)
    expect(res.body).toMatch(/name="alwaysPause"/)
    expect(res.body).toMatch(/value="toggle"/)
  })

  it('escapes what it shows, since process names come from the machine', async () => {
    await deps.state.gamePause('<script>x</script>.exe is running')
    const res = response()
    await createHandler(deps)(request({ url: '/' }), res)
    expect(res.body).not.toMatch(/<script>x/)
  })
})
