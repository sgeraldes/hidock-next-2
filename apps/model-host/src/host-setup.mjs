/**
 * The last step of setup, done by the host instead of the person.
 *
 * The pyannote weights need a Hugging Face token. HiDock Next already has one,
 * so the person never looks for it: the installer only puts the runtime in
 * place, and HiDock sends its token over the paired connection. The host keeps
 * it, runs the model once on a synthetic clip, and only then offers to diarize.
 * A green light that never ran the model is not a result.
 */

export const VALIDATION_MODEL = 'pyannote/speaker-diarization-3.1'

/** No whitespace, no control characters, a sane length: a token, not a message. */
const TOKEN_PATTERN = /^[A-Za-z0-9_\-.]{8,200}$/

/** Six seconds of 16 kHz mono PCM: a low tone, a gap, a high tone. */
export function makeTestClip() {
  const rate = 16000
  const samples = rate * 6
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const t = i / rate
    const freq = t < 2.5 ? 180 : t < 3.5 ? 0 : 320
    const value = freq === 0 ? 0 : Math.round(12000 * Math.sin(2 * Math.PI * freq * t))
    data.writeInt16LE(value, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

export class HostSetup {
  /**
   * @param {object} deps
   * @param {boolean} deps.validated what config.json says
   * @param {string} deps.hfToken what secrets.json holds, or ''
   * @param {(audio: Buffer, options: object) => Promise<object>} deps.diarize
   * @param {() => object} deps.jobOptions
   * @param {(token: string) => void} deps.saveToken writes secrets.json
   * @param {(patch: object) => void} deps.saveValidated writes config.json
   * @param {(message: string) => void} [deps.log]
   */
  constructor(deps) {
    this.deps = deps
    this.log = deps.log || (() => {})
    this.hfToken = deps.hfToken || ''
    this.status = deps.validated ? 'ready' : this.hfToken ? 'not-validated' : 'needs-token'
    this.reason = ''
    this.device = ''
    this.running = null
    /** A different token arrived while a test was running. */
    this.rerun = false
  }

  /** The token the worker gets. */
  token() {
    return this.hfToken
  }

  canDiarize() {
    return this.status === 'ready'
  }

  /** What /health tells a paired client. Never the token. */
  report() {
    return {
      status: this.status,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.device ? { device: this.device } : {}),
    }
  }

  /** At start: a host that has a token but never proved the model does it now. */
  start() {
    if (this.status === 'not-validated') this.#validate()
  }

  /** HiDock sent its token. Keep it and prove the model with it. */
  async receiveToken(raw) {
    const token = String(raw ?? '').trim()
    if (!TOKEN_PATTERN.test(token)) throw Object.assign(new Error('that is not a Hugging Face token'), { status: 400 })
    if (token === this.hfToken && (this.status === 'ready' || this.running)) return this.report()
    this.deps.saveToken(token)
    this.hfToken = token
    // A test already running uses the previous token; this one is tested right
    // after it, so the token on disk is always the one the status speaks for.
    if (this.running) this.rerun = true
    else this.#validate()
    return this.report()
  }

  /**
   * Reinstall the CUDA build of torch (HiDock asks, over the paired
   * connection), then prove the model again. Answers when the reinstall ends;
   * the model test follows in the background like after a token.
   */
  async repair() {
    if (!this.deps.repair) throw Object.assign(new Error('this host cannot repair its runtime'), { status: 404 })
    // Synchronous when nothing runs, so the status says repairing at once.
    if (this.running) await this.idle()
    this.status = 'repairing'
    this.reason = ''
    this.running = (async () => {
      try {
        await this.deps.repair()
        return true
      } catch (error) {
        this.status = 'failed'
        this.reason = String(error?.message || error).slice(0, 400)
        this.log(`[setup] repairing the runtime failed: ${this.reason}`)
        return false
      } finally {
        this.running = null
      }
    })()
    if (await this.running) this.#validate()
    return this.report()
  }

  /** Resolves when no validation is running. For tests and for shutdown. */
  async idle() {
    while (this.running) await this.running
  }

  #validate() {
    if (this.running) return
    this.status = 'validating'
    this.reason = ''
    this.log('[setup] running the voice model once on a test clip')
    this.rerun = false
    this.running = (async () => {
      try {
        const result = await this.deps.diarize(makeTestClip(), {
          ...this.deps.jobOptions(),
          hfToken: this.hfToken,
          model: VALIDATION_MODEL,
          fallbackModel: VALIDATION_MODEL,
          minSpeechSeconds: 0.5,
          extension: '.wav',
        })
        this.device = String(result.device || '')
        this.deps.saveValidated({ validated: true, validatedDevice: this.device })
        this.status = 'ready'
        this.log(`[setup] the voice model ran on ${this.device || 'an unknown device'}; the host can diarize`)
      } catch (error) {
        this.status = 'failed'
        // The worker's last lines say what went wrong; the token is never in them.
        this.reason = String(error?.message || error).split('\n').slice(-3).join(' ').slice(0, 400)
        this.log(`[setup] the voice model did not run: ${this.reason}`)
      } finally {
        this.running = null
        if (this.rerun) this.#validate()
      }
    })()
  }
}
