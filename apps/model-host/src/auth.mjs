/**
 * Pairing: a code you can read off the host's screen, exchanged once for a
 * token the client keeps.
 *
 * The code is short because a person types it, so it expires and it is
 * single-use. The token is long because nobody types it.
 */

import { randomBytes, timingSafeEqual } from 'crypto'

/** Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32
/** A person reads this off a screen and types it on another machine. */
const CODE_DIGITS = 8
/** Short window: the code only has to survive walking to the other machine. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

/** Constant-time compare that does not leak length through an early return. */
export function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    // Still compare something of equal length so the answer takes the same
    // time whether the length matched or not.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

export class PairingStore {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] injected clock, for tests
   * @param {{tokens: string[]}} [options.persisted] tokens from disk
   * @param {(tokens: string[]) => void} [options.save] persist the token list
   */
  constructor(options = {}) {
    this.now = options.now || (() => Date.now())
    this.tokens = new Set(options.persisted?.tokens ?? [])
    this.save = options.save || (() => {})
    /** @type {{code: string, expiresAt: number} | null} */
    this.pending = null
  }

  /** Show a fresh code. Only one is ever outstanding. */
  openPairing() {
    const code = Array.from(randomBytes(CODE_DIGITS))
      .map((byte) => String(byte % 10))
      .join('')
    this.pending = { code, expiresAt: this.now() + PAIRING_CODE_TTL_MS }
    return code
  }

  closePairing() {
    this.pending = null
  }

  /**
   * Exchange a code for a token.
   *
   * @returns {{ok: true, token: string} | {ok: false, reason: string}}
   */
  redeem(code) {
    if (!this.pending) return { ok: false, reason: 'Pairing is not open on the host.' }
    if (this.now() > this.pending.expiresAt) {
      this.pending = null
      return { ok: false, reason: 'That code expired. Open pairing on the host again.' }
    }
    if (!secretsMatch(String(code ?? ''), this.pending.code)) {
      // A wrong code does NOT burn the pending one: a typo would otherwise send
      // the person back to the other machine for a new code.
      return { ok: false, reason: 'That code does not match.' }
    }
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    this.tokens.add(token)
    this.pending = null
    this.save([...this.tokens])
    return { ok: true, token }
  }

  /** Is this Authorization header one of ours? */
  accepts(headerValue) {
    const raw = String(headerValue ?? '')
    const match = /^Bearer\s+(.+)$/i.exec(raw)
    if (!match) return false
    const presented = match[1].trim()
    for (const known of this.tokens) {
      if (secretsMatch(presented, known)) return true
    }
    return false
  }

  revokeAll() {
    this.tokens.clear()
    this.save([])
  }
}
