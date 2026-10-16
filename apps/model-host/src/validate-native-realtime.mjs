import { createHash } from 'node:crypto'
import { readFileSync, statSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeRealtimeRuntime } from './realtime-native-runtime.mjs'
import { realtimeFingerprint } from './realtime-readiness.mjs'
import { REALTIME_MODEL } from './realtime-gateway.mjs'
import { loadConfig, updateConfigFile } from './config.mjs'

const DELTA = 'conversation.item.input_audio_transcription.delta'
const FINAL = 'conversation.item.input_audio_transcription.completed'
const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Refuse conversion, oversized input, ambiguous chunks and malformed/truncated sample containers. */
export function parseValidationWav(wav) {
  if (wav.length > 600000 || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF'
      || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length) throw Error('Bounded RIFF WAV required')
  let pcm, format = false
  for (let offset = 12; offset < wav.length;) {
    if (offset + 8 > wav.length) throw Error('Truncated WAV chunk')
    const tag = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > wav.length) throw Error('Truncated WAV payload')
    if (tag === 'fmt ') {
      if (format || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
        || wav.readUInt32LE(start + 4) !== 16000 || wav.readUInt32LE(start + 8) !== 32000
        || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw Error('Mono 16kHz PCM16 required')
      format = true
    }
    if (tag === 'data') { if (pcm) throw Error('Multiple audio chunks refused'); pcm = wav.subarray(start, start + size) }
    offset = start + size + size % 2
  }
  if (!format || !pcm || pcm.length % 2 || pcm.length < 32000 || pcm.length > 480000) throw Error('Explicit spoken fixture must contain 1-15 seconds')
  return pcm
}

/** Store no raw transcript, deltas, model errors, or paths in validation evidence. */
export function summarizeEvent(event, ms, beforeCommit, sentSeconds) {
  const text = typeof event.delta === 'string' ? event.delta : typeof event.transcript === 'string' ? event.transcript : ''
  return { type: typeof event.type === 'string' ? event.type : 'invalid', ms, beforeCommit, sentSeconds,
    characters: text.length, ...(text ? { textHash: digest(text) } : {}) }
}

/** Pure admission gate shared with tests; a final-only stream can never become live-ready. */
export function validationPassed(sessions) {
  if (sessions.length !== 2) return false
  const [full, cancelled] = sessions
  return full.cancel === false && cancelled.cancel === true && sessions.every(s => s.cleanShutdown === true
    && s.device === 'cuda' && !s.lifecycleError && !s.events.some(e => ['error', 'invalid'].includes(e.type)))
    && Number.isFinite(full.commitMs) && full.events.some(e => e.type === DELTA && e.characters > 0 && e.beforeCommit && e.ms < full.commitMs)
    && full.events.some(e => e.type === FINAL && e.characters > 0 && e.ms >= full.commitMs)
    && Number.isFinite(cancelled.cancelMs)
    && cancelled.events.some(e => e.type === 'input_audio_buffer.cleared' && e.ms >= cancelled.cancelMs)
    && !cancelled.events.some(e => e.type === FINAL)
}

export async function exerciseRealtime({ pcm, language, startRuntime, timeoutMs = 120000 }) {
  if (!['en', 'es'].includes(language) || !Buffer.isBuffer(pcm) || pcm.length < 32000 || pcm.length > 480000 || pcm.length % 2)
    throw Error('Bounded language and mono PCM fixture required')
  const began = performance.now(), controller = new AbortController(), sessions = []
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 120000))
  const check = () => { if (controller.signal.aborted) throw Error('Realtime validation deadline exceeded') }
  try {
    for (const cancel of [false, true]) {
      const report = { cancel, events: [], cleanShutdown: false, device: null }, started = performance.now()
      sessions.push(report)
      let runtime, sentSeconds = 0, failure
      const wait = async (predicate, maxMs = 10000) => {
        const end = performance.now() + maxMs
        while (!predicate()) { check(); if (failure) throw failure; if (performance.now() > end) throw Error('Realtime validation event deadline'); await delay(20) }
      }
      try {
        runtime = await startRuntime({ signal: controller.signal, onMessage: data => {
          try {
            const event = JSON.parse(data.toString())
            if (report.events.length >= 2000) throw Error('Event bound exceeded')
            report.events.push(summarizeEvent(event, performance.now() - started, report.commitMs === undefined, sentSeconds))
            if (event.type === 'error') failure = Error('Native realtime error event')
          } catch { failure = Error('Invalid native realtime event') }
        } })
        runtime.socket.on('error', () => { failure = Error('Native realtime socket error') })
        const has = type => report.events.some(e => e.type === type)
        await wait(() => has('session.created'))
        runtime.socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: 16000, language,
          automatic_punctuation: true, word_timestamps: true, speaker_diarization: false } }))
        await wait(() => has('session.updated'))
        const audio = cancel ? pcm.subarray(0, Math.min(pcm.length, 96000)) : pcm
        const feedStart = performance.now()
        for (let offset = 0; offset < audio.length; offset += 3200) {
          await delay(Math.max(0, feedStart + offset / 32 - performance.now()))
          check(); if (failure) throw failure
          if (runtime.socket.bufferedAmount > 64000) throw Error('Audio send backlog exceeded')
          const chunk = audio.subarray(offset, offset + 3200)
          runtime.socket.send(chunk, { binary: true }); sentSeconds += chunk.length / 32000
        }
        await delay(Math.max(0, feedStart + audio.length / 32 - performance.now()))
        if (cancel) {
          report.cancelMs = performance.now() - started
          runtime.socket.send(JSON.stringify({ type: 'response.cancel' }))
          await wait(() => has('input_audio_buffer.cleared'), 5000)
          await delay(300)
        } else {
          report.commitMs = performance.now() - started
          runtime.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          await wait(() => has(FINAL), 15000)
        }
        if (failure) throw failure
      } finally {
        if (runtime) {
          let closeTimer
          try {
            await Promise.race([runtime.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(Error('Runtime teardown deadline')), 10000) })])
            // Runtime diagnostics must be observed, never inferred from requested --device.
            report.device = runtime.diagnostics?.device ?? null
            report.cleanShutdown = runtime.diagnostics?.cleanShutdown === true
            report.lifecycleError = runtime.diagnostics?.lifecycleError ?? null
            const diagnostics = runtime.diagnostics
            report.evidenceSource = diagnostics?.evidenceSource === 'nvidia-compute-process/nativePid'
              ? diagnostics.evidenceSource : null
            report.nativePid = Number.isInteger(diagnostics?.nativePid) && diagnostics.nativePid > 0
              ? diagnostics.nativePid : null
            // Only supervisor-observed policy values; never substitute requested defaults.
            const policy = diagnostics?.resourcePolicy
            report.resourcePolicy = policy && typeof policy === 'object'
              ? Object.fromEntries(Object.entries(policy).filter(([key, value]) =>
                ['threads', 'logicalProcessors', 'cpuPercent', 'priority', 'memoryMb', 'processorGroups', 'platform'].includes(key)
                && (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
                  || typeof value === 'string' && value.length <= 80))) : null
          } finally { clearTimeout(closeTimer) }
        }
      }
    }
    return { model: REALTIME_MODEL, device: validationPassed(sessions) ? 'cuda' : null,
      partialBeforeCommit: sessions[0].events.some(e => e.type === DELTA && e.characters > 0 && e.beforeCommit && e.ms < sessions[0].commitMs),
      cleanShutdown: sessions.every(s => s.cleanShutdown), sessions, elapsedMs: performance.now() - began,
      success: validationPassed(sessions) }
  } finally { clearTimeout(timer); controller.abort() }
}

async function portClosed(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    let finished = false
    const end = closed => { if (finished) return; finished = true; socket.destroy(); resolve(closed) }
    socket.once('connect', () => end(false)); socket.once('error', error => end(error.code === 'ECONNREFUSED'))
    socket.setTimeout(1000, () => end(false))
  })
}

export async function validateInstalledRealtime({ root, sample, language, alreadyStopped }) {
  if (alreadyStopped !== true) throw Error('Explicit already-stopped authorization is required')
  if (statSync(sample).size > 600000) throw Error('Fixture exceeds validation byte bound')
  const wav = readFileSync(sample), pcm = parseValidationWav(wav)
  const lockPath = join(root, 'asr-preparing.lock')
  const lock = openSync(lockPath, 'wx') // Same exclusion guard as engine preparation; never remove somebody else's lock.
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, purpose: 'validate-native-realtime' }))
    const file = join(root, 'config.json'), config = loadConfig(file)
    for (const port of new Set([config.port || 8765, config.tlsPort || (config.port || 8765) + 1])) {
      if (!await portClosed(port)) throw Error('Host must remain stopped during realtime validation')
    }
    const pythonPath = config.pythonPath || join(root, 'runtime', 'python', 'python.exe')
    const fingerprint = realtimeFingerprint(pythonPath, root)
    const report = await exerciseRealtime({ pcm, language, startRuntime: nativeRealtimeRuntime({ pythonPath, root,
      workerPath: join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'speaker-linking', 'worker.py') }) })
    if (!report.success || realtimeFingerprint(pythonPath, root) !== fingerprint) throw Error('Realtime validation failed; readiness not written')
    const proof = { ...report, testedAt: new Date().toISOString(), fingerprint, sourceHash: digest(wav) }
    updateConfigFile({ realtimeAsrValidation: proof }, file)
    return proof
  } finally { closeSync(lock); unlinkSync(lockPath) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, sample, language, stopped] = process.argv.slice(2)
  validateInstalledRealtime({ root, sample, language, alreadyStopped: stopped === '--already-stopped' })
    .then(proof => console.log(JSON.stringify(proof)))
    .catch(() => { console.error('Native realtime validation failed; no readiness proof written.'); process.exitCode = 1 })
}
