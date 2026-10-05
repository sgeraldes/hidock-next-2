import { spawn } from 'child_process'

/**
 * Spawn a long-running CLI and stream its stderr to the parent's console as
 * lines arrive (so the user sees progress live) while collecting stdout into
 * a buffer for the caller. Used for the VibeVoice/local-asr backends, where
 * the Python CLI logs model load, chunk progress, and generation status to
 * stderr over minutes — execFileBuffered would hide all of that until exit.
 *
 * The optional onStderrLine callback lets callers translate recognised log
 * lines into progress events (e.g. "Chunk 2/3" -> setProgress).
 */
export function spawnStreaming(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal
    cwd?: string
    env?: NodeJS.ProcessEnv
    maxStdoutBytes?: number
    logPrefix?: string
    onStderrLine?: (line: string) => void
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stopped: Promise<void> | undefined
    const abort = () => {
      if (process.platform === 'win32' && child.pid) {
        stopped = new Promise<void>((done) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] })
          killer.once('error', () => { child.kill(); done() })
          killer.once('close', () => done())
        })
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      }
    }
    options.signal?.addEventListener('abort', abort, { once: true })

    const prefix = options.logPrefix ?? `[${command}]`
    const cap = options.maxStdoutBytes ?? 50 * 1024 * 1024

    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBuf = ''
    const stderrLines: string[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= cap) stdoutChunks.push(chunk)
    })

    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk
      // Emit every complete line live so the user sees progress.
      let nl: number
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(nl + 1)
        if (line) {
          console.log(`${prefix} ${line}`)
          stderrLines.push(line)
          try { options.onStderrLine?.(line) } catch { /* ignore callback errors */ }
        }
      }
    })

    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', abort)
      reject(new Error(`Failed to spawn ${command}: ${err.message}`))
    })

    child.on('close', async (code) => {
      options.signal?.removeEventListener('abort', abort)
      // Flush any trailing stderr without newline.
      if (stderrBuf) {
        console.log(`${prefix} ${stderrBuf}`)
        stderrLines.push(stderrBuf)
        stderrBuf = ''
      }
      if (options.signal?.aborted) {
        await stopped
        reject(options.signal.reason ?? new Error('Stopped by you'))
        return
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const stderr = stderrLines.join('\n')
      if (code !== 0) {
        const tail = stderr.split('\n').slice(-30).join('\n')
        reject(new Error(`${command} exited with code ${code}\n${tail}`))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}
