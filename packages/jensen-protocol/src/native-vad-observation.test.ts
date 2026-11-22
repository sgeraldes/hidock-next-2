import { describe, expect, it } from 'vitest'
import {
  NATIVE_VAD_OBSERVATION_CANDIDATE_COMMAND,
  encodeNativeVadObservationCandidateRequest,
  parseNativeVadObservationCandidateReply,
} from './native-vad-observation.js'

interface Fields {
  status?: number; version?: number; flags?: number; nativeState?: number
  attempted?: number; successful?: number; lastStatus?: number; word?: number
  ageLow?: number; ageHigh?: number; sequence?: number
}

function reply(fields: Fields = {}): Uint8Array {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer)
  bytes[0] = fields.status ?? 0
  bytes[1] = fields.version ?? 1
  bytes[2] = fields.flags ?? 1
  bytes[3] = fields.nativeState ?? 1
  view.setUint32(4, fields.attempted ?? 9)
  view.setUint32(8, fields.successful ?? 4)
  view.setInt32(12, fields.lastStatus ?? -5)
  view.setUint32(16, fields.word ?? 0xffffffff)
  view.setUint32(20, fields.ageLow ?? 0)
  view.setUint32(24, fields.ageHigh ?? 0)
  view.setUint32(28, fields.sequence ?? 10)
  return bytes
}

const unknowns = { age: null, dspFreshness: 'unknown', voice: 'unknown', clockBinding: 'unclocked', imageAttested: false }

describe('native VAD observation candidate request', () => {
  it('is the exact one-byte version body under a tentative command id', () => {
    expect(NATIVE_VAD_OBSERVATION_CANDIDATE_COMMAND).toBe(0xf11a)
    expect(encodeNativeVadObservationCandidateRequest()).toEqual(Uint8Array.of(1))
  })
  it('returns a fresh array each call', () => {
    const first = encodeNativeVadObservationCandidateRequest()
    first[0] = 9
    expect(encodeNativeVadObservationCandidateRequest()).toEqual(Uint8Array.of(1))
  })
})

describe('native VAD observation candidate reply: accepted shapes', () => {
  it('decodes the contract byte layout (C golden vector with the unclocked flags and zero age)', () => {
    const golden = Uint8Array.of(
      0x00, 0x01, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x04, 0xff, 0xff, 0xff, 0xfb,
      0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a)
    expect(reply({ nativeState: 5 })).toEqual(golden)
    expect(parseNativeVadObservationCandidateReply(golden)).toEqual({
      status: 'ok', version: 1, nativeState: 5, hasSample: true, attemptedReads: 9, successfulReads: 4,
      lastCompletedNativeStatus: -5, lastSuccessfulCallerWord: 0xffffffff, sequence: 10, ...unknowns,
    })
  })
  it('keeps a valid raw 0 distinct from no successful observation', () => {
    const sampled = parseNativeVadObservationCandidateReply(reply({ word: 0, lastStatus: 0 }))
    expect(sampled).toMatchObject({ status: 'ok', hasSample: true, lastSuccessfulCallerWord: 0 })
    const absent = parseNativeVadObservationCandidateReply(reply({ flags: 0, word: 0, successful: 0, attempted: 3, lastStatus: -7 }))
    expect(absent).toMatchObject({ status: 'ok', hasSample: false, lastSuccessfulCallerWord: null, attemptedReads: 3, successfulReads: 0, lastCompletedNativeStatus: -7 })
  })
  it('never infers voice or freshness from a nonzero raw word', () => {
    const parsed = parseNativeVadObservationCandidateReply(reply({ word: 1 }))
    expect(parsed).toMatchObject({ lastSuccessfulCallerWord: 1, voice: 'unknown', dspFreshness: 'unknown', age: null })
  })
  it('reports a pristine no-sample reply with zero counters', () => {
    expect(parseNativeVadObservationCandidateReply(reply({ flags: 0, attempted: 0, successful: 0, lastStatus: 0, word: 0, sequence: 0 })))
      .toMatchObject({ status: 'ok', hasSample: false, attemptedReads: 0, successfulReads: 0, lastCompletedNativeStatus: 0, lastSuccessfulCallerWord: null, sequence: 0 })
  })
  it('decodes the signed status extremes and keeps large unsigned words unsigned', () => {
    expect(parseNativeVadObservationCandidateReply(reply({ lastStatus: -0x80000000, word: 0x80000000, sequence: 0xfffffffe })))
      .toMatchObject({ lastCompletedNativeStatus: -0x80000000, lastSuccessfulCallerWord: 0x80000000, sequence: 0xfffffffe })
    expect(parseNativeVadObservationCandidateReply(reply({ lastStatus: 0x7fffffff })))
      .toMatchObject({ lastCompletedNativeStatus: 0x7fffffff })
  })
  it('accepts wrapped counters, including successes exceeding attempts', () => {
    expect(parseNativeVadObservationCandidateReply(reply({ attempted: 3, successful: 0xfffffffe, lastStatus: 0 })))
      .toMatchObject({ status: 'ok', attemptedReads: 3, successfulReads: 0xfffffffe })
    expect(parseNativeVadObservationCandidateReply(reply({ attempted: 0, successful: 7 })))
      .toMatchObject({ status: 'ok', attemptedReads: 0, successfulReads: 7 })
  })
  it('decodes a view that does not start at the buffer origin', () => {
    const padded = new Uint8Array(40)
    padded.set(reply({ word: 0x01020304 }), 5)
    expect(parseNativeVadObservationCandidateReply(padded.subarray(5, 37))).toMatchObject({ lastSuccessfulCallerWord: 0x01020304 })
  })
  it('keeps HAS_SAMPLE true with a wrapped successful counter of 0', () => {
    expect(parseNativeVadObservationCandidateReply(reply({ flags: 1, attempted: 5, successful: 0, word: 0 })))
      .toMatchObject({ status: 'ok', hasSample: true, successfulReads: 0, lastSuccessfulCallerWord: 0 })
  })
  it.each([0, 2, 7, 0xff])('decodes BUSY with preserved native state %i and no metrics', nativeState => {
    const body = new Uint8Array(32)
    body[0] = 1; body[1] = 1; body[3] = nativeState
    expect(parseNativeVadObservationCandidateReply(body)).toEqual({
      status: 'busy', version: 1, nativeState, clockBinding: 'unclocked', imageAttested: false,
    })
  })
  it('decodes UNAVAILABLE with native state 0 and no metrics', () => {
    expect(parseNativeVadObservationCandidateReply(Uint8Array.of(2, 1, ...new Uint8Array(30)))).toEqual({
      status: 'unavailable', version: 1, nativeState: 0, clockBinding: 'unclocked', imageAttested: false,
    })
  })
})

describe('native VAD observation candidate reply: rejected shapes', () => {
  const valid = reply()
  it('the unmodified fixture parses, so each rejection below is attributable to its mutation', () => {
    expect(parseNativeVadObservationCandidateReply(valid)).not.toBeNull()
  })
  it.each([
    ['empty', new Uint8Array(0)],
    ['legacy 1-byte error 0x01', Uint8Array.of(1)],
    ['legacy 1-byte error 0xff', Uint8Array.of(0xff)],
    ['legacy 1-byte zero', Uint8Array.of(0)],
    ['truncated by one', valid.subarray(0, 31)],
    ['truncated to header', valid.subarray(0, 4)],
    ['overlong by one', Uint8Array.of(...valid, 0)],
    ['two replies concatenated', Uint8Array.of(...valid, ...valid)],
  ])('rejects %s', (_name, body) => {
    expect(parseNativeVadObservationCandidateReply(body)).toBeNull()
  })
  it.each([0, 2, 0xff])('rejects version %i on OK, BUSY and UNAVAILABLE', version => {
    expect(parseNativeVadObservationCandidateReply(reply({ version }))).toBeNull()
    expect(parseNativeVadObservationCandidateReply(reply({ status: 1, version, flags: 0, attempted: 0, successful: 0, lastStatus: 0, word: 0, sequence: 0 }))).toBeNull()
    expect(parseNativeVadObservationCandidateReply(reply({ status: 2, version, flags: 0, nativeState: 0, attempted: 0, successful: 0, lastStatus: 0, word: 0, sequence: 0 }))).toBeNull()
  })
  it.each([3, 4, 0x80, 0xff])('rejects unknown status %i', status => {
    expect(parseNativeVadObservationCandidateReply(reply({ status }))).toBeNull()
  })
  it.each([0x08, 0x10, 0x80, 0xf8, 0xf9])('rejects reserved flags 0x%s', flags => {
    expect(parseNativeVadObservationCandidateReply(reply({ flags }))).toBeNull()
  })
  it.each([0x02, 0x03, 0x04, 0x05, 0x06, 0x07])('rejects age flags 0x%s: the unclocked binding cannot claim age or regression', flags => {
    expect(parseNativeVadObservationCandidateReply(reply({ flags }))).toBeNull()
  })
  it('rejects nonzero age fields instead of reporting 0 ms or an age', () => {
    expect(parseNativeVadObservationCandidateReply(reply({ ageLow: 1 }))).toBeNull()
    expect(parseNativeVadObservationCandidateReply(reply({ ageHigh: 1 }))).toBeNull()
    expect(parseNativeVadObservationCandidateReply(reply({ ageLow: 0xffffffff, ageHigh: 0xffffffff }))).toBeNull()
    expect(parseNativeVadObservationCandidateReply(reply({ flags: 0, attempted: 1, successful: 0, lastStatus: -1, word: 0, ageLow: 1 }))).toBeNull()
  })
  it.each([1, 3, 0x7fffffff, 0xffffffff])('rejects odd sequence %i on OK (writer inside the seqlock)', sequence => {
    expect(parseNativeVadObservationCandidateReply(reply({ sequence }))).toBeNull()
  })
  it.each([
    ['BUSY with flags', { status: 1, flags: 1 }],
    ['BUSY with an attempted counter', { status: 1, flags: 0, attempted: 1, successful: 0, lastStatus: 0, word: 0, sequence: 0 }],
    ['BUSY with a sequence', { status: 1, flags: 0, attempted: 0, successful: 0, lastStatus: 0, word: 0 }],
    ['BUSY with a raw word', { status: 1, flags: 0, attempted: 0, successful: 0, lastStatus: 0, sequence: 0 }],
    ['BUSY with an age field', { status: 1, flags: 0, attempted: 0, successful: 0, lastStatus: 0, word: 0, sequence: 0, ageLow: 1 }],
    ['UNAVAILABLE with flags', { status: 2, flags: 1, nativeState: 0 }],
    ['UNAVAILABLE with a status', { status: 2, flags: 0, nativeState: 0, attempted: 0, successful: 0, word: 0, sequence: 0 }],
    ['UNAVAILABLE with a reserved flag', { status: 2, flags: 0x80, nativeState: 0, attempted: 0, successful: 0, lastStatus: 0, word: 0, sequence: 0 }],
  ] as [string, Fields][])('rejects %s', (_name, fields) => {
    expect(parseNativeVadObservationCandidateReply(reply(fields))).toBeNull()
  })
  it.each([1, 2, 7, 0xff])('rejects UNAVAILABLE with nonzero native state %i, with every other byte valid', nativeState => {
    const body = new Uint8Array(32)
    body[0] = 2; body[1] = 1; body[3] = nativeState
    expect(parseNativeVadObservationCandidateReply(body)).toBeNull()
  })
  it('rejects the last byte of a BUSY tail being set', () => {
    const body = new Uint8Array(32)
    body[0] = 1; body[1] = 1; body[31] = 1
    expect(parseNativeVadObservationCandidateReply(body)).toBeNull()
  })
  it('rejects a no-sample reply carrying a nonzero last-good word', () => {
    expect(parseNativeVadObservationCandidateReply(reply({ flags: 0, successful: 0, attempted: 3, lastStatus: -7, word: 1 }))).toBeNull()
  })
  it.each([1, 5, 0xfffffffe, 0xffffffff])('rejects false HAS_SAMPLE with successfulReads %i: the flag is sticky, so counter wrap cannot explain it', successful => {
    expect(parseNativeVadObservationCandidateReply(reply({ flags: 0, successful, attempted: 3, lastStatus: 0, word: 0 }))).toBeNull()
    expect(parseNativeVadObservationCandidateReply(reply({ flags: 0, successful, attempted: 0xffffffff, lastStatus: -1, word: 0 }))).toBeNull()
  })
  it('keeps a no-sample reply with failed attempts and a native failure status valid', () => {
    expect(parseNativeVadObservationCandidateReply(reply({ flags: 0, successful: 0, attempted: 0xffffffff, lastStatus: -7, word: 0 })))
      .toMatchObject({ status: 'ok', hasSample: false, attemptedReads: 0xffffffff, successfulReads: 0, lastCompletedNativeStatus: -7, lastSuccessfulCallerWord: null })
  })
})
