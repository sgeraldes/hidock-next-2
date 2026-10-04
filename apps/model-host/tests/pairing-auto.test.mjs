import { describe, it, expect } from 'vitest'
import { PairingStore, AUTO_PAIRING_MS } from '../src/auth.mjs'

function store(options = {}) {
  let now = 1_000_000
  const saved = []
  const s = new PairingStore({
    now: () => now,
    save: (tokens, meta) => saved.push({ tokens, meta }),
    ...options,
  })
  return { s, saved, advance: (ms) => (now += ms) }
}

describe('automatic pairing', () => {
  it('opens for five minutes when nobody is paired, and the first HiDock in gets a token with no code', () => {
    const { s } = store()
    s.startAutomatic()
    expect(s.automatic()).toMatchObject({ open: true, remainingMs: AUTO_PAIRING_MS })
    const first = s.redeem('')
    expect(first.ok).toBe(true)
    expect(s.automatic().open).toBe(false)
    expect(s.redeem('').ok).toBe(false)
  })

  it('does not open when a client is already paired', () => {
    const { s } = store({ persisted: { tokens: ['t'] } })
    s.startAutomatic()
    expect(s.automatic().open).toBe(false)
  })

  it('closes by itself after five minutes', () => {
    const { s, advance } = store()
    s.startAutomatic()
    advance(AUTO_PAIRING_MS + 1)
    expect(s.automatic().open).toBe(false)
    expect(s.redeem('').ok).toBe(false)
  })

  it('cancelled, it stays cancelled across a restart of the service', () => {
    const { s, saved } = store()
    s.startAutomatic()
    s.cancelAutomatic()
    expect(s.automatic()).toMatchObject({ open: false, cancelled: true })
    expect(saved.at(-1).meta.autoPairingCancelled).toBe(true)
    const restarted = new PairingStore({ persisted: { tokens: [], autoPairingCancelled: true } })
    restarted.startAutomatic()
    expect(restarted.automatic().open).toBe(false)
  })

  it('can be resumed while nobody has paired, for another five minutes', () => {
    const { s, advance } = store()
    s.startAutomatic()
    s.cancelAutomatic()
    advance(60_000)
    s.resumeAutomatic()
    expect(s.automatic()).toMatchObject({ open: true, cancelled: false, remainingMs: AUTO_PAIRING_MS })
  })

  it('will not resume once a HiDock is paired; disconnecting starts over', () => {
    const { s } = store()
    s.startAutomatic()
    s.redeem('')
    s.resumeAutomatic()
    expect(s.automatic().open).toBe(false)
    s.resetPairing()
    expect(s.tokens.size).toBe(0)
    expect(s.automatic().open).toBe(true)
  })

  it('a code still works, and a wrong code does not pair during the automatic window', () => {
    const { s } = store()
    s.startAutomatic()
    expect(s.redeem('12345678').ok).toBe(false)
    const code = s.openPairing()
    expect(s.redeem(code).ok).toBe(true)
  })
})
