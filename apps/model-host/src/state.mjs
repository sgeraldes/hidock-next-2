/**
 * What the host is willing to do right now.
 *
 * Four states, because the spec's controls have to have visible and distinct
 * effects. `busy` is not a control, it is what `ready` looks like while one
 * heavy job holds the lane.
 *
 * A pause has an author. The person pauses from the control page or the
 * pause/resume shortcut; game mode pauses when a game takes the machine. Game
 * mode only ever undoes its own pauses, so a person who paused before playing
 * does not find the host working again when the game closes.
 */

export const STOPPED = 'stopped'
export const READY = 'ready'
export const PAUSED = 'paused'

const TRANSITIONS = {
  start: { from: [STOPPED, PAUSED], to: READY },
  pause: { from: [STOPPED, READY, PAUSED], to: PAUSED },
  stop: { from: [STOPPED, READY, PAUSED], to: STOPPED },
}

const REASONS = {
  you: 'The host is paused. Nobody but you can resume it.',
  game: 'The host is paused while a game runs on that machine.',
}

export class HostState {
  /**
   * @param {object} [options]
   * @param {string} [options.initial] state to start in
   * @param {() => Promise<void>} [options.onLeaveReady] called when work must stop
   * @param {() => number} [options.now] clock, injected for tests
   */
  constructor(options = {}) {
    this.state = options.initial || STOPPED
    this.onLeaveReady = options.onLeaveReady || (async () => {})
    this.now = options.now || Date.now
    /** Told after every change of state; main.mjs starts and stops game mode's probe on it. */
    this.onChange = options.onChange || (() => {})
    /** The one heavy job, or null. Small control calls never take this. */
    this.activeJob = null
    /** PID of that job's worker, so game mode never pauses for the host's own GPU work. */
    this.workerPid = null
    /** Why the host is not accepting work, in the user's words. */
    this.reason = 'The host has not been started.'
    /** { by: 'you' | 'game', detail, since } while paused, else null. */
    this.pause = null
    /**
     * True after the person resumed during a game. Game mode then leaves the
     * host working until that game ends, instead of pausing it again on the
     * next look.
     */
    this.gameOverride = false
  }

  /** True only when a NEW heavy job may be admitted right now. */
  canAdmit() {
    return this.state === READY && this.activeJob === null
  }

  /** What /health reports. `busy` is derived, never stored. */
  publicState() {
    if (this.state === READY && this.activeJob !== null) return 'busy'
    return this.state
  }

  /** Who paused the host and why, or null when it is not paused. */
  pauseInfo() {
    return this.state === PAUSED && this.pause ? { ...this.pause } : null
  }

  /**
   * Apply a control action. Returns the new public state.
   *
   * `toggle` is the one-click control: it pauses a working host and resumes or
   * starts any other. Pausing or stopping while a job runs asks that job to
   * stop and does not wait for it: the job's own teardown removes its temp file
   * and the client runs the recording locally.
   */
  async apply(action) {
    if (action === 'toggle') {
      return this.apply(this.state === READY ? 'pause' : 'start')
    }
    const transition = TRANSITIONS[action]
    if (!transition) throw new Error(`unknown control action: ${action}`)
    if (!transition.from.includes(this.state)) {
      throw new Error(`cannot ${action} while ${this.state}`)
    }
    if (action === 'start' && this.pause?.by === 'game') this.gameOverride = true
    if (action === 'stop') this.gameOverride = false
    await this.#enter(transition.to, transition.to === PAUSED ? { by: 'you', detail: '' } : null)
    return this.publicState()
  }

  /** Game mode saw a game. Pauses a working host; touches nothing else. */
  async gamePause(detail) {
    if (this.gameOverride) return
    if (this.state === PAUSED && this.pause?.by === 'game') {
      this.pause.detail = detail
      return
    }
    if (this.state !== READY) return
    await this.#enter(PAUSED, { by: 'game', detail })
  }

  /** Game mode saw the game end long enough ago. Undoes only its own pause. */
  gameResume() {
    if (this.state !== PAUSED || this.pause?.by !== 'game') return
    this.state = READY
    this.pause = null
    this.reason = ''
    this.onChange(this)
  }

  async #enter(to, pause) {
    const previous = this.state
    this.state = to
    this.pause = pause ? { ...pause, since: this.now() } : null
    this.reason =
      to === READY ? '' : to === PAUSED ? REASONS[pause.by] : 'The host is stopped.'
    this.onChange(this)
    if (previous === READY && to !== READY) {
      await this.onLeaveReady()
    }
  }
}
