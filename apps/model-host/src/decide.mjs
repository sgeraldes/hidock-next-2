/**
 * Clef and Clef-Flash on the host: Cloudflare's decision models, answering the same
 * `/v1/systemone` body as Jev.
 *
 * A model is downloaded the first time HiDock asks for it, at a pinned revision, because its
 * schema head is Python in the repository and this host runs only the revision we read.
 * One Python process keeps one model on the GPU: loading takes tens of seconds and a
 * decision tens of milliseconds. It exits after a while without requests, which gives the
 * VRAM back, and the tray icon ends it with everything else when the gamestation steps aside.
 */

import { spawn } from 'child_process'
import { existsSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'

export const DECIDE_MODELS = {
  // 9B, BF16 as published: about 19 GB on the 4090's 23 GB.
  'clef-flash': {
    repo: 'Cloudflare/clef-flash',
    revision: '17f0b0ad64efb65d273590632833508766b2aae6', // pragma: allowlist secret (a public commit id)
    bytes: 19_083_377_402,
    quantize: 'none',
  },
  // 27B: BF16 is 55 GB, so the backbone is loaded in 4-bit NF4.
  clef: {
    repo: 'Cloudflare/clef',
    revision: '2f3de3dd85f379784083b0814d997ab627200f0c', // pragma: allowlist secret (a public commit id)
    bytes: 54_989_894_057,
    quantize: 'nf4',
  },
}

const QUESTION_TYPES = new Set(['noul', 'choice', 'score'])
const STDERR_TAIL = 4000

/** An error with the HTTP status the route answers with, and anything to add to the body. */
export class DecisionError extends Error {
  constructor(message, status, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/** '' for a body the host can answer, otherwise what is wrong with it. */
export function checkDecisionRequest(body, catalog = DECIDE_MODELS) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object'
  if (!Object.hasOwn(catalog, body.model)) return `model must be ${Object.keys(catalog).join(' or ')}`
  if (!('state' in body)) return 'state is required'
  if (body.images !== undefined) return 'images are not supported by this host yet'
  if (body.videos !== undefined) return 'videos are not supported by this host yet'
  const questions = body.questions
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    return 'at least one question is required'
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!question || !QUESTION_TYPES.has(question.type)) return `${id}: type must be noul, choice or score`
    if (question.type !== 'noul') {
      const criteria = question.criteria
      const empty = !criteria || (Array.isArray(criteria) ? criteria.length === 0 : Object.keys(criteria).length === 0)
      if (empty) return `${id}: criteria must not be empty`
    }
  }
  return ''
}

/** Bytes under a directory, partial downloads included. */
function sizeOf(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += sizeOf(path)
    else if (entry.isFile()) total += statSync(path).size
  }
  return total
}

export class DecideModels {
  /**
   * @param {object} options
   * @param {string} options.pythonPath
   * @param {string} options.workerPath decide_worker.py
   * @param {string} options.modelsDir
   * @param {object} [options.env] extra environment for the worker (thread limits)
   * @param {number} [options.idleMs] how long a loaded model waits for the next request
   * @param {number} [options.loadTimeoutMs]
   * @param {number} [options.decideTimeoutMs]
   * @param {object} [options.catalog]
   * @param {typeof spawn} [options.spawnFn]
   * @param {(line: string) => void} [options.log]
   */
  constructor(options) {
    this.options = options
    this.catalog = options.catalog || DECIDE_MODELS
    this.spawnFn = options.spawnFn || spawn
    this.log = options.log || (() => {})
    this.idleMs = options.idleMs ?? 10 * 60_000
    this.loadTimeoutMs = options.loadTimeoutMs ?? 15 * 60_000
    this.decideTimeoutMs = options.decideTimeoutMs ?? 2 * 60_000
    /** { name, child } while a download runs. */
    this.download = null
    /** Why the last download of each model failed. */
    this.failures = {}
    /** The resident worker: { child, pending: Map, nextId, stderr }. */
    this.worker = null
    this.loaded = null
    this.loading = null
    this.idleTimer = null
    this.queue = Promise.resolve()
  }

  modelDir(name) {
    const { revision } = this.catalog[name]
    return join(this.options.modelsDir, `${name}@${revision.slice(0, 12)}`)
  }

  onDisk(name) {
    return existsSync(join(this.modelDir(name), '.complete'))
  }

  /** What /health tells a paired HiDock about each model. */
  report() {
    const out = {}
    for (const name of Object.keys(this.catalog)) {
      const totalBytes = this.catalog[name].bytes
      let state = 'absent'
      if (this.loaded === name) state = 'loaded'
      else if (this.loading === name) state = 'loading'
      else if (this.onDisk(name)) state = 'on-disk'
      else if (this.download?.name === name) state = 'downloading'
      else if (this.failures[name]) state = 'failed'
      out[name] = {
        state,
        totalBytes,
        ...(state === 'downloading' ? { bytes: sizeOf(this.modelDir(name)) } : {}),
        ...(state === 'failed' ? { error: this.failures[name] } : {}),
      }
    }
    return out
  }

  /** Answer one SystemOne request with the model it names. */
  async decide(request) {
    const name = request.model
    if (!this.onDisk(name)) {
      this.#startDownload(name)
      const busy = this.download && this.download.name !== name
      const message = busy
        ? `${this.download.name} is downloading; ask for ${name} again when it is on disk, and its download starts then`
        : `${name} is downloading to this host; ask again when it is on disk`
      throw new DecisionError(message, 503, { decide: this.report() })
    }
    const run = this.queue.then(() => this.#run(name, request))
    // The next request waits for this one, whatever happens to it.
    this.queue = run.catch(() => {})
    return run
  }

  /** End the worker and any download: the host stepped aside or stopped. */
  stop() {
    this.#stopWorker()
    if (this.download) {
      const { child } = this.download
      this.download = null
      child.kill()
    }
  }

  async #run(name, request) {
    clearTimeout(this.idleTimer)
    try {
      if (this.loaded !== name) await this.#load(name)
      const reply = await this.#send({ op: 'decide', request }, this.decideTimeoutMs)
      return reply.response
    } finally {
      this.idleTimer = setTimeout(() => {
        this.log('[decide] no requests for a while; letting the model go')
        this.#stopWorker()
      }, this.idleMs)
      this.idleTimer.unref?.()
    }
  }

  async #load(name) {
    const { quantize } = this.catalog[name]
    this.loaded = null
    this.loading = name
    try {
      const reply = await this.#send(
        { op: 'load', path: this.modelDir(name), quantize, device: 'cuda' },
        this.loadTimeoutMs
      )
      this.loaded = name
      this.log(`[decide] ${name} loaded in ${reply.seconds} s, ${reply.vramMiB ?? '?'} MiB on the GPU`)
    } finally {
      this.loading = null
    }
  }

  #ensureWorker() {
    if (this.worker) return this.worker
    const child = this.spawnFn(this.options.pythonPath, [this.options.workerPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.options.env || {}) },
    })
    const worker = { child, pending: new Map(), nextId: 1, stderr: '' }
    this.worker = worker
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      worker.stderr = (worker.stderr + chunk).slice(-STDERR_TAIL)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      const waiting = worker.pending.get(message.id)
      if (!waiting) return
      worker.pending.delete(message.id)
      waiting.settle(message)
    })
    const gone = (why) => {
      if (this.worker === worker) {
        this.worker = null
        this.loaded = null
      }
      const detail = worker.stderr.trim().split('\n').slice(-6).join('\n')
      for (const waiting of worker.pending.values()) {
        waiting.fail(new DecisionError(`the decision worker stopped (${why})${detail ? `: ${detail}` : ''}`, 500))
      }
      worker.pending.clear()
    }
    child.on('error', (error) => gone(error.message))
    child.on('close', (code) => gone(`exit code ${code}`))
    child.stdin.on('error', () => {})
    return worker
  }

  #send(message, timeoutMs) {
    const worker = this.#ensureWorker()
    const id = worker.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id)
        // A worker that does not answer may be holding the GPU; end it.
        if (this.worker === worker) this.#stopWorker()
        reject(new DecisionError(`the model did not answer within ${Math.round(timeoutMs / 1000)} s`, 504))
      }, timeoutMs)
      worker.pending.set(id, {
        settle: (reply) => {
          clearTimeout(timer)
          if (reply.ok) resolve(reply)
          else reject(new DecisionError(reply.error || 'the decision failed', reply.invalid ? 400 : 500))
        },
        fail: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      worker.child.stdin.write(`${JSON.stringify({ id, ...message })}\n`)
    })
  }

  #stopWorker() {
    clearTimeout(this.idleTimer)
    const worker = this.worker
    if (!worker) return
    this.worker = null
    this.loaded = null
    worker.child.kill()
  }

  #startDownload(name) {
    if (this.download) return
    const { repo, revision } = this.catalog[name]
    const dir = this.modelDir(name)
    delete this.failures[name]
    this.log(`[decide] downloading ${repo}@${revision} to ${dir}`)
    const child = this.spawnFn(
      this.options.pythonPath,
      [this.options.workerPath, '--download', repo, '--revision', revision, '--dir', dir],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...(this.options.env || {}) } }
    )
    const download = { name, child }
    this.download = download
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL)
    })
    const finish = (code, why) => {
      // stop() already let it go on purpose.
      if (this.download !== download) return
      this.download = null
      if (code === 0) {
        writeFileSync(join(dir, '.complete'), `${repo}@${revision}\n`)
        this.log(`[decide] ${name} is on disk`)
        return
      }
      const detail = stderr.trim().split('\n').slice(-3).join(' | ')
      this.failures[name] = `the download ${why}${detail ? `: ${detail}` : ''}`
      this.log(`[decide] ${name}: ${this.failures[name]}`)
    }
    child.on('error', (error) => finish(-1, `could not start: ${error.message}`))
    child.on('close', (code) => finish(code, `exited with code ${code}`))
  }
}
