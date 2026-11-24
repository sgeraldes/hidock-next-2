import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DeviceFileSystem } from './device-file-system'
const run = promisify(execFile)
export interface DeviceDriveStatus { mounted: boolean; drive: string | null; readOnly: true; windowsFileLimitBytes: number | null }

/** Per-user temporary Windows WebClient mapping. Never changes service/registry policy. */
export class DeviceDrive {
  private mapping: { drive: string; url: string; unc: string } | null = null
  private limit: number | null = null
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly filesystem: DeviceFileSystem) {}
  status(): DeviceDriveStatus { return { mounted: this.mapping !== null, drive: this.mapping?.drive ?? null, readOnly: true, windowsFileLimitBytes: this.limit } }
  private ordered<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
  mount(): Promise<DeviceDriveStatus> {
    return this.ordered(async () => {
      if (process.platform !== 'win32') throw Error('Drive mapping is available on Windows')
      if (this.mapping) return this.status()
      const drives = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0,1) }'], { windowsHide: true, timeout: 10000 })
      const net = await run('net.exe', ['use'], { windowsHide: true, timeout: 10000 })
      const used = new Set(drives.stdout.split(/\s+/).filter(Boolean))
      for (const match of net.stdout.matchAll(/\b([A-Z]):\s/g)) used.add(match[1])
      const letter = [...'RHIJKLPQSTUVWX'].find(value => !used.has(value))
      if (!letter) throw Error('No unused drive letter is available')
      const status = await this.filesystem.start()
      if (!status.mountUrl) throw Error('Device filesystem is unavailable')
      const url = new URL(status.mountUrl)
      const unc = `\\\\127.0.0.1@${url.port}\\DavWWWRoot\\${url.pathname.split('/')[1]}`
      try { await run('net.exe', ['use', `${letter}:`, status.mountUrl, '/persistent:no'], { windowsHide: true, timeout: 20000 }) }
      catch (error) {
        const code = String((error as { stderr?: string }).stderr ?? '').match(/(?:System error|Error de sistema|Error del sistema)\s+(\d{1,5})\b/i)?.[1]
        // execFile errors include the secret URL; never propagate the original error.
        // eslint-disable-next-line preserve-caught-error -- Preserving the original cause would disclose the private capability URL.
        throw Error(`Windows could not map the device drive${code ? ` (error ${code})` : ''}`)
      }
      this.mapping = { drive: `${letter}:`, url: status.mountUrl, unc }
      try {
        const value = await run('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters', '/v', 'FileSizeLimitInBytes'], { windowsHide: true, timeout: 5000 })
        const hex = value.stdout.match(/REG_DWORD\s+(0x[0-9a-f]+)/i)?.[1]
        this.limit = hex ? parseInt(hex, 16) : null
      } catch { this.limit = null }
      return this.status()
    })
  }
  unmount(): Promise<DeviceDriveStatus> {
    return this.ordered(async () => {
      if (this.mapping) {
        const mapping = this.mapping
        const current = await run('net.exe', ['use', mapping.drive], { windowsHide: true, timeout: 10000 }).catch(() => null)
        if (current && !current.stdout.toLowerCase().includes(mapping.unc.toLowerCase()) && !current.stdout.includes(mapping.url.replace(/\/$/, ''))) throw Error('The drive mapping changed outside HiDock; it was preserved')
        if (current) {
          try { await run('net.exe', ['use', mapping.drive, '/delete', '/y'], { windowsHide: true, timeout: 20000 }) }
          catch { throw Error('Windows could not unmap the device drive') }
        }
        this.mapping = null
      }
      await this.filesystem.stop()
      return this.status()
    })
  }
}
