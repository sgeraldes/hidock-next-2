import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A model proof keeps a fingerprint of the runtime that passed its test, so a
 * changed worker or runtime is tested again. The host's own scripts in src/ are
 * part of that fingerprint, and their line endings depend on the checkout the
 * installer was built from: 0.5.x shipped them with LF, 0.6.0 and 0.6.1 were
 * built from a checkout with core.autocrlf=true and shipped CRLF. Hashing the
 * raw bytes made that update drop every prepared model (semantic embeddings and
 * the ASR models) although no script changed. The host's own scripts are hashed
 * with LF line endings; files from other packages and binaries keep raw bytes.
 */
const here = resolve(dirname(fileURLToPath(import.meta.url)))
export const SOURCE_FORMS = Object.freeze(['lf', 'crlf', 'raw'])

export function isHostSource(path) {
  return resolve(dirname(path)) === here
}

/** The bytes a fingerprint hashes for this file, in the given line-ending form. */
export function fingerprintBytes(path, form = 'lf') {
  const bytes = readFileSync(path)
  if (form === 'raw' || !isHostSource(path)) return bytes
  const lf = bytes.toString('latin1').replace(/\r\n/g, '\n')
  return Buffer.from(form === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf, 'latin1')
}

export function sourceDigest(path, form = 'lf') {
  return createHash('sha256').update(fingerprintBytes(path, form)).digest('hex')
}

/**
 * True when the stored fingerprint matches the runtime in any line-ending form.
 * New proofs store the LF form. 'raw' and 'crlf' accept proofs written before
 * this change. A runtime that cannot be read fails closed.
 */
export function fingerprintMatches(expected, compute) {
  if (typeof expected !== 'string' || !expected) return false
  try {
    return SOURCE_FORMS.some(form => compute(form) === expected)
  } catch {
    return false
  }
}

export async function fingerprintMatchesAsync(expected, compute) {
  if (typeof expected !== 'string' || !expected) return false
  try {
    for (const form of SOURCE_FORMS) if (await compute(form) === expected) return true
    return false
  } catch {
    return false
  }
}
