import { test } from 'vitest'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { parseValidationWav, summarizeEvent, validationPassed, exerciseRealtime, validateInstalledRealtime } from '../src/validate-native-realtime.mjs'
const delta = 'conversation.item.input_audio_transcription.delta'
const final = 'conversation.item.input_audio_transcription.completed'
const good = () => [
  { cancel: false, cleanShutdown: true, device: 'cuda', commitMs: 10, events: [
    { type: delta, characters: 2, beforeCommit: true, ms: 5 }, { type: final, characters: 4, ms: 12 }] },
  { cancel: true, cleanShutdown: true, device: 'cuda', cancelMs: 5, events: [{ type: 'input_audio_buffer.cleared', ms: 8 }] }
]
test('requires a genuine partial before commit, final, cancel acknowledgement and clean CUDA teardown', () => {
  assert.equal(validationPassed(good()), true)
  for (const change of [
    s => { s[0].events[0].beforeCommit = false }, s => { s[0].events[0].characters = 0 },
    s => { s[0].events[0].ms = 10 }, s => { s[0].events.pop() }, s => { s[1].events = [] },
    s => { s[1].events.push({ type: final, characters: 3, ms: 9 }) }, s => { s[0].device = 'cpu' },
    s => { s[1].cleanShutdown = false }, s => { s[0].lifecycleError = 'spawn failed' },
    s => { s[0].events.push({ type: 'error' }) }
  ]) { const sessions = good(); change(sessions); assert.equal(validationPassed(sessions), false) }
})
test('evidence contains only text length and hash', () => {
  const event = summarizeEvent({ type: delta, delta: 'private fixture', error: { message: 'private error' } }, 1, true, .1)
  assert.equal(event.characters, 15)
  assert.match(event.textHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(event).includes('private'), false)
})
function wav(seconds = 1) {
  const b = Buffer.alloc(44 + seconds * 32000)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b
}
test('input parser validates duration, format and complete PCM container', () => {
  assert.equal(parseValidationWav(wav()).length, 32000)
  assert.equal(parseValidationWav(wav(15)).length, 480000)
  assert.throws(() => parseValidationWav(wav(16)))
  const stereo = wav(); stereo.writeUInt16LE(2, 22); assert.throws(() => parseValidationWav(stereo))
  assert.throws(() => parseValidationWav(wav().subarray(0, 60)))
})
test('missing stopped guard fails before reading fixture or starting any runtime', async () => {
  await assert.rejects(validateInstalledRealtime({ root: 'not-used', sample: 'not-read', language: 'es' }), /already-stopped/)
})
test('executes the paced protocol and awaits teardown for complete and controlled-cancel sessions', async () => {
  let starts = 0, closes = 0
  const report = await exerciseRealtime({ pcm: Buffer.alloc(32000), language: 'es', timeoutMs: 5000,
    startRuntime: async ({ onMessage }) => {
      starts++
      const socket = new EventEmitter(); socket.bufferedAmount = 0
      const emit = event => onMessage(Buffer.from(JSON.stringify(event)))
      setImmediate(() => emit({ type: 'session.created' }))
      socket.send = data => {
        if (Buffer.isBuffer(data)) { emit({ type: delta, delta: 'test' }); return }
        const event = JSON.parse(data)
        if (event.type === 'session.update') emit({ type: 'session.updated' })
        if (event.type === 'input_audio_buffer.commit') emit({ type: final, transcript: 'test' })
        if (event.type === 'response.cancel') emit({ type: 'input_audio_buffer.cleared' })
      }
      const diagnostics = { device: 'cuda', cleanShutdown: false }
      return { socket, diagnostics, close: async () => { closes++; diagnostics.cleanShutdown = true } }
    } })
  assert.equal(report.success, true)
  assert.equal(starts, 2); assert.equal(closes, 2)
  assert.equal(JSON.stringify(report).includes('"test"'), false)
})
