import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, test } from 'node:test'

import {
  NATIVE_VOICE_ENERGY_OBSERVATION_COMMAND,
  decodeNativeVoiceEnergyObservationReply,
  encodeNativeVoiceEnergyObservationRequest,
  NativeVoiceEnergyDecodeError,
  parseNativeVoiceEnergyObservationReply
} from '../../../../../packages/jensen-protocol/src/native-voice-energy-observation.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cFixtureScript = resolve(here, 'run-c-fixture.sh')
let replies: Map<string, Uint8Array>

function wslPath(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  assert.ok(match, `expected a Windows drive path for WSL: ${path}`)
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
}

function compileAndRunRealCEncoder(): Map<string, Uint8Array> {
  const stdout = execFileSync('wsl.exe', ['bash', wslPath(cFixtureScript)], { encoding: 'utf8' })
  const parsed = new Map<string, Uint8Array>()
  for (const line of stdout.trim().split(/\r?\n/)) {
    const separator = line.indexOf(' ')
    assert.notEqual(separator, -1, `malformed C fixture output: ${line}`)
    const label = line.slice(0, separator)
    const hex = line.slice(separator + 1)
    assert.equal(hex.length, 64, `${label} did not contain 32 bytes`)
    parsed.set(label, Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16)))
  }
  return parsed
}

before(() => {
  replies = compileAndRunRealCEncoder()
})

test('request encoder emits exactly the v2 selector byte', () => {
  assert.equal(NATIVE_VOICE_ENERGY_OBSERVATION_COMMAND, 0xf11a)
  assert.deepEqual(encodeNativeVoiceEnergyObservationRequest(), Uint8Array.of(0x02))
})

test('decodes all real C encoder cases without assigning voice or freshness semantics', () => {
  assert.equal(replies.size, 5)
  const sourceUnknown = { version: 2, voice: 'unknown', source: 'unknown', freshness: 'unknown', age: null, imageAttested: false }
  assert.deepEqual(decodeNativeVoiceEnergyObservationReply(replies.get('ok-sample')!), {
    ...sourceUnknown, status: 0, hasSample: true, attempts: 0xaabbccdd, successes: 0x01020304,
    providerStatus: -7, raw: 0x87654321, sequence: 0x11223344
  })
  assert.deepEqual(decodeNativeVoiceEnergyObservationReply(replies.get('ok-no-sample')!), {
    ...sourceUnknown, status: 0, hasSample: false, attempts: 0xaabbccdd, successes: 0,
    providerStatus: -7, raw: null, sequence: 0x11223344
  })
  assert.deepEqual(decodeNativeVoiceEnergyObservationReply(replies.get('ok-zero-sample')!), {
    ...sourceUnknown, status: 0, hasSample: true, attempts: 0xaabbccdd, successes: 0x01020304,
    providerStatus: -7, raw: 0, sequence: 0x11223344
  })
  assert.deepEqual(decodeNativeVoiceEnergyObservationReply(replies.get('busy')!), {
    ...sourceUnknown, status: 1, hasSample: false, attempts: 0, successes: 0, providerStatus: 0, raw: null, sequence: 0
  })
  assert.deepEqual(decodeNativeVoiceEnergyObservationReply(replies.get('unavailable')!), {
    ...sourceUnknown, status: 2, hasSample: false, attempts: 0, successes: 0, providerStatus: 0, raw: null, sequence: 0
  })
  assert.equal(parseNativeVoiceEnergyObservationReply(replies.get('ok-sample')!)?.raw, 0x87654321)
})

test('rejects unsupported versions, status values, flags, reserved bytes, and nonempty non-OK bodies', () => {
  const base = replies.get('ok-sample')!
  const mutate = (offset: number, value: number): Uint8Array => {
    const copy = base.slice()
    copy[offset] = value
    return copy
  }
  const expectCode = (body: Uint8Array, code: string) => assert.throws(
    () => decodeNativeVoiceEnergyObservationReply(body),
    (error: unknown) => error instanceof NativeVoiceEnergyDecodeError && error.code === code
  )

  expectCode(base.subarray(0, 31), 'invalid-length')
  assert.equal(parseNativeVoiceEnergyObservationReply(base.subarray(0, 31)), null)
  expectCode(mutate(0, 3), 'invalid-status')
  expectCode(mutate(1, 1), 'invalid-version')
  expectCode(mutate(2, 0x02), 'unknown-flags')
  expectCode(mutate(3, 1), 'reserved-nonzero')
  expectCode(mutate(31, 1), 'reserved-nonzero')

  const oddSequence = base.slice()
  oddSequence[23] |= 1
  expectCode(oddSequence, 'odd-sequence')

  const noSampleWithSuccesses = replies.get('ok-no-sample')!.slice()
  noSampleWithSuccesses[11] = 1
  expectCode(noSampleWithSuccesses, 'unsampled-payload-nonzero')
  const noSampleWithRaw = replies.get('ok-no-sample')!.slice()
  noSampleWithRaw[19] = 1
  expectCode(noSampleWithRaw, 'unsampled-payload-nonzero')

  const busyWithData = replies.get('busy')!.slice()
  busyWithData[4] = 1
  expectCode(busyWithData, 'non-ok-payload-nonempty')

  const unavailableWithFlag = replies.get('unavailable')!.slice()
  unavailableWithFlag[2] = 1
  expectCode(unavailableWithFlag, 'non-ok-payload-nonempty')
})
