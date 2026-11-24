import { spawn, type ChildProcess } from 'child_process'
import { availableParallelism } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import { getConfig } from './config'

/** Attach only to the freshly created, still-idle worker owned by this caller. */
export async function guardOwnedWorker(pid: number, memoryBytes: number, onFailure: () => void): Promise<() => void> {
  if (process.platform !== 'win32') return () => {}
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources && join(resources, 'speaker-linking', 'resource_policy.py')
  const script = packaged && existsSync(packaged) ? packaged : join(process.cwd(), 'resources', 'speaker-linking', 'resource_policy.py')
  const policy = getConfig().transcription
  const percent = Math.max(10, Math.min(100, Number(policy.speakerLinkingCpuPercent) || 50))
  let guard: ChildProcess
  let disposed = false
  const dispose = () => { disposed = true; guard?.kill() }
  try {
    await new Promise<void>((resolve, reject) => {
      guard = spawn('python', [script, String(pid), String(process.pid)], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HIDOCK_DIARIZATION_THREADS: String(Math.max(1, Math.floor(availableParallelism() * percent / 100))),
          HIDOCK_WORKER_MEMORY_MB: String(Math.floor(memoryBytes / 1024 ** 2)),
          HIDOCK_WORKER_PRIORITY: policy.localComputePriority || 'below-normal' }
      })
      let ready = false
      let output = ''
      let errorText = ''
      const timer = setTimeout(() => { reject(new Error('Resource policy attachment timed out')); dispose() }, 10_000)
      guard.stdout!.on('data', (chunk: Buffer) => {
        if (ready) return
        output += chunk.toString()
        if (output.length > 8192) { clearTimeout(timer); reject(new Error('Invalid resource policy response')); dispose(); return }
        if (!output.includes('\n')) return
        try {
          const report = JSON.parse(output.split('\n')[0])
          if (!report.threads || !report.memoryMb) throw new Error('Resource policy was not confirmed')
          ready = true; clearTimeout(timer); resolve()
        } catch (error) { clearTimeout(timer); reject(error); dispose() }
      })
      guard.stderr!.on('data', (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(-4096) })
      guard.on('error', error => { clearTimeout(timer); reject(error); if (ready && !disposed) onFailure() })
      guard.on('exit', () => {
        clearTimeout(timer)
        if (!ready) reject(new Error('Resource policy failed: ' + errorText))
        else if (!disposed) onFailure()
      })
    })
    return dispose
  } catch (error) { dispose(); throw error }
}
