// Node >=22. Run only inside the host's bounded Windows Job supervisor.
// --exe <native exe> --model <GGUF> --audio <mono16kPCM16 WAV> --out <new JSON> [--language es]
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => i % 2 ? a : [...a, [v, all[i + 1]]], []))
for (const flag of ['--exe', '--model', '--audio', '--out']) if (!args[flag]) throw Error(`Missing ${flag}`)
if (!existsSync(args['--model'])) throw Error('Local model file required; downloads are not allowed')
if (existsSync(args['--out'])) throw Error('Refusing to overwrite evidence')
if (statSync(args['--audio']).size > 8 * 1024 ** 2) throw Error('Audio size exceeds diagnostic limit')
const wav = readFileSync(args['--audio'])
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw Error('RIFF WAVE required')
let pcm, rate
for (let offset = 12; offset + 8 <= wav.length;) {
  const kind = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8
  if (start + size > wav.length) throw Error('Truncated WAV')
  if (kind === 'fmt ') {
    if (size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt16LE(start + 14) !== 16) throw Error('Mono PCM16 required')
    rate = wav.readUInt32LE(start + 4)
  }
  if (kind === 'data') pcm = wav.subarray(start, start + size)
  offset = start + size + size % 2
}
if (rate !== 16000 || !pcm || pcm.length < 160000) throw Error('At least 5 seconds mono 16kHz PCM16 required')
const report = { startedAt: new Date().toISOString(), sourceHash: createHash('sha256').update(wav).digest('hex'),
  language: args['--language'] || 'es', sessions: [], success: false }
const started = performance.now(), deadline = started + 60000
let child, exited = false, stderr = '', fatal, timer
const sockets = new Set()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = () => { if (fatal) throw fatal; if (performance.now() > deadline) throw Error('60-second diagnostic deadline') }
async function wait(predicate, maxMs = 10000) {
  const end = Math.min(deadline, performance.now() + maxMs)
  while (!predicate()) { check(); if (performance.now() > end) throw Error('Protocol event deadline'); await delay(20) }
}
async function session(port, cancel) {
  const s = { cancel, events: [], sentSeconds: 0 }, began = performance.now()
  report.sessions.push(s)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/transcriptions/realtime`)
  sockets.add(ws)
  let failed, closed = false
  ws.addEventListener('error', () => { failed = Error('WebSocket error') })
  ws.addEventListener('close', () => { closed = true; sockets.delete(ws) })
  ws.addEventListener('message', ({ data }) => {
    try {
      const e = JSON.parse(data), text = e.delta ?? e.transcript ?? ''
      s.events.push({ type: e.type, ms: performance.now() - began, sentSeconds: s.sentSeconds,
        beforeCommit: s.commitMs === undefined, characters: text.length,
        ...(text ? { textHash: createHash('sha256').update(text).digest('hex') } : {}), audioProcessed: e.audio_processed })
      if (e.type === 'error') failed = Error(e.error?.message || 'Server error')
    } catch (error) { failed = error }
  })
  const event = type => s.events.some(e => e.type === type)
  const until = predicate => wait(() => { if (failed) throw failed; if (closed) throw Error('Unexpected socket close'); return predicate() })
  await until(() => event('session.created'))
  ws.send(JSON.stringify({ type: 'session.update', session: { sample_rate: rate, language: report.language,
    automatic_punctuation: true, word_timestamps: true, speaker_diarization: false } }))
  await until(() => event('session.updated'))
  const count = cancel ? 30 : 50, feedStart = performance.now()
  for (let i = 0; i < count; i++) {
    check(); if (failed) throw failed
    await delay(Math.max(0, feedStart + i * 100 - performance.now()))
    if (ws.bufferedAmount > 64000) throw Error('Send backlog exceeds two seconds')
    ws.send(pcm.subarray(i * 3200, (i + 1) * 3200))
    s.sentSeconds = (i + 1) / 10
  }
  await delay(Math.max(0, feedStart + count * 100 - performance.now()))
  if (cancel) {
    ws.send(JSON.stringify({ type: 'response.cancel' }))
    await until(() => event('input_audio_buffer.cleared'))
    const finals = s.events.filter(e => e.type.endsWith('.completed')).length
    await delay(300)
    s.cancelAcknowledged = true
    s.noFinalAfterClear = finals === s.events.filter(e => e.type.endsWith('.completed')).length
  } else {
    s.commitMs = performance.now() - began
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    await until(() => event('input_audio_buffer.committed'))
    s.partialBeforeFinish = s.events.some(e => e.type.endsWith('.delta') && e.characters > 0 && e.beforeCommit && e.sentSeconds < 5)
    s.finalReceived = s.events.some(e => e.type.endsWith('.completed') && e.characters > 0)
  }
  ws.close(1000)
  await wait(() => closed, 2000)
  s.socketClosed = true
}
try {
  // Reserve an ephemeral loopback port, then release for the owned server.
  const probe = createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  child = spawn(args['--exe'], ['serve', '--asr-model', args['--model'], '--host', '127.0.0.1', '--port', String(port),
    '--device', args['--device'] || 'cuda', '--threads', '2', '--no-ui', '--max-upload-mb', '8'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  report.pid = child.pid
  child.on('error', error => { fatal = error })
  child.on('close', (code, signal) => { exited = true; report.exitCode = code; report.exitSignal = signal })
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
  timer = setTimeout(() => { fatal = Error('60-second diagnostic deadline'); for (const ws of sockets) ws.close(); child.kill() }, 60000)
  let ready = false
  while (!ready) {
    check(); if (exited) throw Error('Server exited before readiness')
    try { const r = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) }); ready = r.ok && (await r.json()).ready === true } catch {}
    if (!ready) await delay(200)
  }
  report.readyMs = performance.now() - started
  await session(port, false)
  await session(port, true)
  report.success = report.sessions[0].partialBeforeFinish && report.sessions[0].finalReceived &&
    report.sessions[1].cancelAcknowledged && report.sessions[1].noFinalAfterClear
} catch (error) { report.error = error.message }
finally {
  clearTimeout(timer)
  for (const ws of sockets) ws.close()
  if (child && !exited) {
    if (process.platform === 'win32' && child.pid) {
      await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        const killTimer = setTimeout(() => { killer.kill(); resolve() }, 3000)
        killer.on('error', () => { clearTimeout(killTimer); resolve() })
        killer.on('close', () => { clearTimeout(killTimer); resolve() })
      })
    } else child.kill()
    const end = performance.now() + 2000
    while (!exited && performance.now() < end) await delay(20)
  }
  report.processExited = exited
  report.success = !!report.success && exited
  report.elapsedMs = performance.now() - started
  report.stderrTail = stderr
  writeFileSync(args['--out'], JSON.stringify(report, null, 2), { flag: 'wx' })
  process.exit(report.success ? 0 : 1)
}
