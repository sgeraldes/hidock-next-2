/** Source-candidate codec for the proposed read-only native VAD observation command.
 * The command id is tentative and unallocated, and no firmware, device class or app uses it.
 * Byte parsing only: nothing here attests a physical VAD signal, an image or an installed firmware.
 * First binding is UNCLOCKED, so age is never reported and a reply claiming one is rejected.
 */
export const NATIVE_VAD_OBSERVATION_CANDIDATE_COMMAND = 0xf11a
export const NATIVE_VAD_OBSERVATION_CANDIDATE_REPLY_BYTES = 32

const VERSION = 1
const STATUS_OK = 0
const STATUS_BUSY = 1
const STATUS_UNAVAILABLE = 2
const FLAG_HAS_SAMPLE = 0x01

interface NativeVadObservationCandidateBase {
  version: 1
  /** Raw native state byte; no physical meaning is assigned to its values. */
  nativeState: number
  clockBinding: 'unclocked'
  imageAttested: false
}

export type NativeVadObservationCandidate =
  | (NativeVadObservationCandidateBase & {
    status: 'ok'
    hasSample: boolean
    attemptedReads: number
    successfulReads: number
    lastCompletedNativeStatus: number
    /** Last word the native caller consumed after a successful read; null while hasSample is false. Not a voice flag. */
    lastSuccessfulCallerWord: number | null
    sequence: number
    age: null
    dspFreshness: 'unknown'
    voice: 'unknown'
  })
  | (NativeVadObservationCandidateBase & { status: 'busy' | 'unavailable' })

export function encodeNativeVadObservationCandidateRequest(): Uint8Array {
  return Uint8Array.of(VERSION)
}

/** Returns null for anything but an exact 32-byte reply that satisfies the unclocked contract. */
export function parseNativeVadObservationCandidateReply(body: Uint8Array): NativeVadObservationCandidate | null {
  if (!(body instanceof Uint8Array) || body.length !== NATIVE_VAD_OBSERVATION_CANDIDATE_REPLY_BYTES) return null
  const [status, version, flags, nativeState] = body
  if (version !== VERSION || (flags & ~FLAG_HAS_SAMPLE) !== 0) return null
  const base = { version: VERSION, nativeState, clockBinding: 'unclocked', imageAttested: false } as const

  if (status === STATUS_BUSY || status === STATUS_UNAVAILABLE) {
    if (flags !== 0 || body.subarray(4).some(byte => byte !== 0)) return null
    if (status === STATUS_UNAVAILABLE && nativeState !== 0) return null
    return { ...base, status: status === STATUS_BUSY ? 'busy' : 'unavailable' }
  }
  if (status !== STATUS_OK) return null

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const attemptedReads = view.getUint32(4)
  const successfulReads = view.getUint32(8)
  const lastCompletedNativeStatus = view.getInt32(12)
  const word = view.getUint32(16)
  const sequence = view.getUint32(28)
  if (view.getUint32(20) !== 0 || view.getUint32(24) !== 0) return null
  if (sequence % 2 !== 0) return null

  const hasSample = (flags & FLAG_HAS_SAMPLE) !== 0
  // HAS_SAMPLE is sticky after the first success, so counter wrap never clears it.
  if (!hasSample && (word !== 0 || successfulReads !== 0)) return null

  return {
    ...base,
    status: 'ok',
    hasSample,
    attemptedReads,
    successfulReads,
    lastCompletedNativeStatus,
    lastSuccessfulCallerWord: hasSample ? word : null,
    sequence,
    age: null,
    dspFreshness: 'unknown',
    voice: 'unknown',
  }
}
