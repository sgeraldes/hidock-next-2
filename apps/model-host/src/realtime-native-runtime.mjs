import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, freemem, totalmem } from 'node:os'
import { WebSocket } from 'ws'

export function hasNativeCudaProcess(csv, nativePid) {
  if (!Number.isInteger(nativePid) || nativePid <= 0) return false
  return String(csv).split(/\r?\n/).some(line => {
    const [pid, memory] = line.split(',').map(value => value.trim())
    return /^\d+$/.test(pid) && Number(pid) === nativePid && typeof memory === 'string' && memory.length > 0
  })
}

async function observeCudaProcess(diagnostics) {
  const csv = await new Promise(resolve => {
    execFile('nvidia-smi', ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader'],
      { timeout: 2000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout))
  })
  if (hasNativeCudaProcess(csv, diagnostics.nativePid)) {
    diagnostics.device = diagnostics.observedDevice = 'cuda'
    diagnostics.evidenceSource = 'nvidia-compute-process/nativePid'
  }
}

/** v0.2.0 /ready.device is the CLI label, NOT accelerator detection (app/serve.cpp:558). */
export function recordNativeReady(diagnostics, ready) {
  diagnostics.nativeReady = ready?.ready === true
  diagnostics.requestedDeviceLabel = typeof ready?.device === 'string' ? ready.device.slice(0, 120) : null
  diagnostics.observedDevice = null
}

export function recordSupervisorEvent(diagnostics, event) {
  if (event.resourcePolicy && typeof event.resourcePolicy === 'object') diagnostics.resourcePolicy = event.resourcePolicy
  if (Number.isInteger(event.nativePid) && event.nativePid > 0) diagnostics.nativePid = event.nativePid
  if (Number.isInteger(event.nativeExitCode)) diagnostics.nativeExitCode = event.nativeExitCode
  if (typeof event.nativeTerminatedOnStop === 'boolean') diagnostics.nativeTerminatedOnStop = event.nativeTerminatedOnStop
  if (event.forcedTermination === true) diagnostics.forcedTermination = true
  if (typeof event.nativeStderrTail === 'string') diagnostics.nativeStderrTail = event.nativeStderrTail.slice(-4000)
}

/** Factory has trusted installation paths only; never accepts executable/model paths over the wire. */
export function nativeRealtimeRuntime({ pythonPath, workerPath, root }) {
  return async ({ signal, onMessage }) => {
    if (process.platform !== 'win32') throw Error('Native realtime requires Windows Job enforcement')
    const mb = Math.floor(Math.min(8 * 1024, totalmem() / 1048576 * .25, freemem() / 1048576 * .5))
    if (mb < 4096) throw Error('Insufficient available memory for native realtime')
    const probe = createServer()
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    if (signal.aborted) throw Error('Live session cancelled')
    const exe = join(root, 'runtime', 'asr-nemotron', 'nemo-speech-0.2.0-windows-x86_64-cuda', 'bin', 'nemo-speech.exe')
    const model = join(root, 'models', 'nemotron-3.5-asr-streaming-0.6b-gguf', 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf')
    const child = spawn(pythonPath, ['-S', join(dirname(fileURLToPath(import.meta.url)), 'realtime_native_supervisor.py'),
      '--policy', join(dirname(workerPath), 'resource_policy.py'), '--exe', exe, '--model', model, '--port', String(port)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
        HIDOCK_DIARIZATION_THREADS: String(Math.max(1, Math.floor(cpus().length / 2))),
        HIDOCK_WORKER_MEMORY_MB: String(mb), HIDOCK_WORKER_PRIORITY: 'below-normal' } })
    const diagnostics = { observedDevice: null, device: null, evidenceSource: null, cleanShutdown: false,
      lifecycleError: null, requestedDeviceLabel: null, childExitCode: null,
      spawnError: null, forcedTermination: false, resourcePolicy: null, nativePid: null, nativeExitCode: null }
    let exited = false, stopping = false, socket, errorTail = '', forceTimer, stdout = ''
    const done = new Promise((resolve, reject) => {
      child.once('close', (code, signalName) => {
        exited = true; diagnostics.childExitCode = code; diagnostics.exitSignal = signalName
        diagnostics.processExited = true; clearTimeout(forceTimer)
        if (diagnostics.spawnError || (!stopping && code !== 0)) {
          diagnostics.lifecycleError = diagnostics.spawnError || `Native supervisor exited ${code}`
          reject(Error(diagnostics.lifecycleError))
        }
        else resolve()
      })
      child.once('error', error => { diagnostics.spawnError = error.message.slice(0, 500) })
    })
    // Consumers await done after startup; retain failures without an unhandled rejection during preparation.
    void done.catch(() => {})
    child.stderr.on('data', data => { errorTail = (errorTail + data).slice(-2000) })
    child.stdin.on('error', error => { diagnostics.stdinError = error.code || 'stdin failure' })
    child.stdout.on('data', data => {
      stdout += data.toString('utf8')
      if (stdout.length > 16000) { diagnostics.protocolError = 'Supervisor diagnostic output exceeded limit'; stop(); return }
      let end
      while ((end = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, end); stdout = stdout.slice(end + 1)
        try { recordSupervisorEvent(diagnostics, JSON.parse(line)) } catch { diagnostics.protocolError = 'Invalid supervisor diagnostics' }
      }
    })
    const stop = () => {
      stopping = true
      socket?.terminate()
      child.stdin.end()
      if (!exited && !forceTimer) forceTimer = setTimeout(() => { diagnostics.forcedTermination = true; child.kill() }, 2000)
    }
    signal.addEventListener('abort', stop, { once: true })
    const close = async () => {
      stop()
      try {
        await done
        diagnostics.cleanShutdown = diagnostics.processExited === true && diagnostics.childExitCode === 0 &&
          diagnostics.nativeTerminatedOnStop === true && Number.isInteger(diagnostics.nativeExitCode) &&
          !diagnostics.spawnError && !diagnostics.forcedTermination && !diagnostics.protocolError
        if (!diagnostics.cleanShutdown) diagnostics.lifecycleError ||= 'Native shutdown was not verified clean'
      } finally { signal.removeEventListener('abort', stop) }
    }
    try {
      const deadline = Date.now() + 45000
      let ready = false
      while (!ready) {
        if (signal.aborted || exited) throw Error(signal.aborted ? 'Live session cancelled' : `Native live startup failed: ${errorTail}`)
        if (Date.now() > deadline) throw Error('Native live startup timed out')
        try {
          const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) })
          const report = await response.json()
          ready = response.ok && report.ready === true
          if (ready) recordNativeReady(diagnostics, report)
        } catch {}
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100))
      }
      await observeCudaProcess(diagnostics)
      if (signal.aborted || exited) throw Error('Native realtime stopped during device verification')
      socket = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/transcriptions/realtime`, {
        maxPayload: 256000, perMessageDeflate: false, handshakeTimeout: 3000 })
      socket.on('message', data => onMessage(data))
      socket.on('close', stop)
      socket.on('error', stop)
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      return { socket, done, close, diagnostics }
    } catch (error) {
      try { await close() } catch (cleanupError) { diagnostics.cleanupError = cleanupError.message }
      error.diagnostics = diagnostics
      throw error
    }
  }
}
