import { WebSocketServer, WebSocket } from 'ws'

export const REALTIME_MODEL = 'nvidia/nemotron-3.5-asr-streaming-0.6b'
export const REALTIME_PATH = '/v1/audio/transcriptions/realtime'
const local = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)

/** One authenticated, bounded, ephemeral stream shares the file/decide execution lane. */
export function attachRealtimeGateway(server, deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32000, perMessageDeflate: false,
    maxFragments: 32, maxBufferedChunks: 64, closeTimeout: 1000 })
  const sessions = new Set()
  const reject = (socket, status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== REALTIME_PATH) return reject(socket, 404)
    if (!req.socket.encrypted && !local(req.socket.remoteAddress)) return reject(socket, 426)
    if (!deps.pairing.accepts(req.headers.authorization)) return reject(socket, 401)
    if (!deps.available()) return reject(socket, 503)
    if (!deps.state.canAdmit()) return reject(socket, 409)
    const controller = new AbortController()
    deps.state.activeJob = controller // reserve before any asynchronous work
    let accepted = false
    const release = () => { if (deps.state.activeJob === controller) deps.state.activeJob = null }
    socket.once('close', () => { if (!accepted) release() })
    try {
      wss.handleUpgrade(req, socket, head, client => {
        accepted = true
        void connect(client, controller, release)
      })
    } catch { release(); socket.destroy() }
  })
  async function connect(client, controller, release) {
    const telemetryId = deps.telemetry?.start('realtime-transcription', REALTIME_MODEL)
    let completed = false, failed = false, finalUsage
    let runtime, closed = false, updated = false, committed = false, cancelling = false, lastMessage = Date.now()
    let bytes = 0, messages = 0, period = Date.now(), audioStart = 0
    let finalTimer
    const send = data => {
      if (client.readyState !== WebSocket.OPEN) return
      if (client.bufferedAmount + Buffer.byteLength(data) > 256000) return fail('Client cannot receive live results')
      client.send(data)
    }
    const fail = message => { failed = true; sendError(message); controller.abort() }
    const sendError = message => {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 256000)
        client.send(JSON.stringify({ type: 'error', error: { message } }))
    }
    const close = () => { closed = true; controller.abort(); client.close(1000); setTimeout(() => client.terminate(), 1000).unref() }
    sessions.add(close)
    const idleTimer = setInterval(() => { if (Date.now() - lastMessage > 60000) fail('Live session idle timeout') }, 1000)
    const durationTimer = setTimeout(() => fail('Live session reached one-hour limit'), 3600000)
    controller.signal.addEventListener('abort', () => { client.close(1000); setTimeout(() => client.terminate(), 1000).unref() }, { once: true })
    client.on('close', close)
    client.on('error', () => fail('Live client transport failed'))
    client.on('message', (data, binary) => {
      if (closed || controller.signal.aborted) return
      lastMessage = Date.now()
      if (lastMessage - period > 1000) { period = lastMessage; messages = 0 }
      if (++messages > 100) return fail('Live message rate exceeded')
      if (!runtime || runtime.socket.readyState !== WebSocket.OPEN) return fail('Wait for session.created before sending audio')
      if (runtime.socket.bufferedAmount + data.length > 64000) return fail('Live audio backlog exceeded two seconds')
      if (binary) {
        if (!updated || committed || !data.length || data.length % 2) return fail('PCM16 audio is not valid in this session state')
        bytes += data.length
        if (bytes > 32000 * 3600 || bytes > ((Date.now() - audioStart) / 1000 + 2) * 32000)
          return fail('Audio must be paced at 16000 mono samples per second')
        runtime.socket.send(data, { binary: true })
        return
      }
      let event
      try { event = JSON.parse(data.toString('utf8')) } catch { return fail('Invalid live JSON') }
      if (event.type === 'session.update' && !updated && !committed) {
        const s = event.session
        if (!s || s.sample_rate !== 16000 || !['en', 'es'].includes(s.language) ||
          s.speaker_diarization === true || (s.model && s.model !== REALTIME_MODEL))
          return fail('Only Nemotron mono PCM16 16kHz, en/es and no diarization are supported')
        updated = true; audioStart = Date.now()
        runtime.socket.send(JSON.stringify({ type: event.type, session: { sample_rate: 16000, language: s.language,
          automatic_punctuation: true, word_timestamps: true, speaker_diarization: false } }))
      } else if (event.type === 'input_audio_buffer.commit' && updated && !committed) {
        committed = true
        runtime.socket.send(JSON.stringify({ type: event.type }))
        finalTimer = setTimeout(() => fail('Live finalization timed out'), 15000)
      } else if (event.type === 'response.cancel' && !cancelling) {
        // Cancel is terminal: never replay or implicitly restart captured audio.
        cancelling = true; committed = true
        clearTimeout(finalTimer)
        runtime.socket.send(JSON.stringify({ type: event.type }))
        finalTimer = setTimeout(close, 1000)
      } else fail('Unsupported live control or session state')
    })
    try {
      runtime = await deps.startRuntime({ signal: controller.signal, onMessage: data => {
        if (controller.signal.aborted) return
        let event
        try { event = JSON.parse(data.toString()) } catch { return fail('Native live result was invalid') }
        if (cancelling && event.type?.endsWith('.completed')) return
        send(JSON.stringify(event))
        if (event.type === 'error') { failed = true; controller.abort() }
        if (event.type === 'input_audio_buffer.cleared') close()
        if (committed && event.type?.endsWith('.completed')) {
          completed = true
          const reported = event.usage?.output_tokens
          finalUsage = Number.isSafeInteger(reported) && reported >= 0 ? { outputTokens: reported } : undefined
          clearTimeout(finalTimer); close()
        }
      } })
      await runtime.done
      if (!controller.signal.aborted) sendError('Native live runtime ended')
    } catch (error) { failed = true; if (!controller.signal.aborted) sendError(error.message) }
    finally {
      clearInterval(idleTimer); clearTimeout(durationTimer); clearTimeout(finalTimer)
      close()
      // close() resolves only after the supervised process exits. Never free an occupied lane early.
      try { await runtime?.close() } finally {
        if (telemetryId) deps.telemetry.finish(telemetryId, failed ? 'failed' : completed ? 'completed' : 'cancelled',
          runtime?.diagnostics?.observedDevice, finalUsage)
        sessions.delete(close); release()
      }
    }
  }
  const close = () => { for (const end of sessions) end(); wss.close() }
  server.on('close', close)
  return { close }
}
