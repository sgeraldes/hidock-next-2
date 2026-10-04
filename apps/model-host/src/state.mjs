/**
 * What the host is willing to do right now.
 *
 * Four states, because the spec's controls have to have visible and distinct
 * effects. `busy` is not a control, it is what `ready` looks like while one
 * heavy job holds the lane.
 */

export const STOPPED = 'stopped'
export const READY = 'ready'
export const PAUSED = 'paused'

const TRANSITIONS = {
  start: { from: [STOPPED, PAUSED], to: READY },
  pause: { from: [STOPPED, READY, PAUSED], to: PAUSED },
  stop: { from: [STOPPED, READY, PAUSED], to: STOPPED },
}

export class HostState {
  /**
   * @param {object} [options]
   * @param {string} [options.initial] state to start in
   * @param {() => Promise<void>} [options.onLeaveReady] called when work must stop
   */
  constructor(options = {}) {
    this.state = options.initial || STOPPED
    this.onLeaveReady = options.onLeaveReady || (async () => {})
    /** The one heavy job, or null. Small control calls never take this. */
    this.activeJob = null
    /** Why the host is not accepting work, in the user's words. */
    this.reason = 'The host has not been started.'
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

  /**
   * Apply a control action. Returns the new public state.
   *
   * Pausing or stopping while a job runs asks that job to stop and does not
   * wait for it: the caller decides how long to allow, and the job's own
   * teardown removes its temp file either way.
   */
  async apply(action) {
    const transition = TRANSITIONS[action]
    if (!transition) throw new Error(`unknown control action: ${action}`)
    if (!transition.from.includes(this.state)) {
      throw new Error(`cannot ${action} while ${this.state}`)
    }
    const previous = this.state
    this.state = transition.to
    this.reason =
      transition.to === READY
        ? ''
        : transition.to === PAUSED
          ? 'The host is paused. Nobody but you can resume it.'
          : 'The host is stopped.'
    if (previous === READY && transition.to !== READY) {
      await this.onLeaveReady()
    }
    return this.publicState()
  }
}
