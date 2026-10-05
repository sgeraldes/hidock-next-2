import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface PcImportResult { success: boolean; error?: string }
type ImportRecording = (path: string) => Promise<PcImportResult>

/** MediaRecorder WebM chunks are fragments of ONE container, appended in order.
 * Like realtime-recorder, unfinished files stay outside the Library until recovery.
 */
export class PcRecorder {
  private active: { id: string; path: string; index: number } | null = null
  private finishing = false
  constructor(private readonly folder: string, private readonly importRecording: ImportRecording) {}

  start(): string {
    if (this.active || this.finishing) throw new Error('A PC recording is already active or saving')
    mkdirSync(this.folder, { recursive: true })
    const id = randomUUID()
    const date = new Date()
    const two = (n: number) => String(n).padStart(2, '0')
    const title = `Recording ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}-${two(date.getMinutes())}`
    const path = join(this.folder, `${title} ${id}.webm.partial`)
    closeSync(openSync(path, 'wx'))
    this.active = { id, path, index: 0 }
    return id
  }

  append(id: string, index: number, data: Uint8Array): void {
    const active = this.requireSession(id)
    if (index !== active.index) throw new Error('Recording chunks arrived out of order')
    if (!(data instanceof Uint8Array) || data.byteLength > 16 * 1024 * 1024) throw new Error('Invalid recording chunk')
    const fd = openSync(active.path, 'a')
    try {
      let written = 0
      while (written < data.byteLength) written += writeSync(fd, data, written, data.byteLength - written)
      fsyncSync(fd)
      active.index++
    } finally { closeSync(fd) }
  }

  async finish(id: string): Promise<PcImportResult> {
    const active = this.requireSession(id)
    this.active = null
    this.finishing = true
    try { return await this.importPartial(active.path) }
    finally { this.finishing = false }
  }

  // Every chunk is closed and synced already; a process exit leaves a recoverable file.
  close(): void { this.active = null }

  async recover(): Promise<void> {
    if (!existsSync(this.folder)) return
    for (const name of readdirSync(this.folder)) {
      if (!/^Recording .* [0-9a-f-]{36}\.webm(?:\.partial)?$/.test(name)) continue
      const path = join(this.folder, name)
      if (path === this.active?.path) continue
      try {
        const result = await this.importPartial(path)
        if (!result.success) console.error('[PcRecorder] Recovery failed:', result.error)
      } catch (error) { console.error('[PcRecorder] Recovery failed:', error) }
    }
  }

  private requireSession(id: string) {
    if (!this.active || this.active.id !== id) throw new Error('Unknown recording session')
    return this.active
  }

  private async importPartial(path: string): Promise<PcImportResult> {
    if (statSync(path).size === 0) {
      unlinkSync(path)
      return { success: false, error: 'No audio was recorded' }
    }
    const final = path.endsWith('.partial') ? path.slice(0, -8) : path
    if (final !== path) renameSync(path, final)
    const result = await this.importRecording(final)
    if (result.success) unlinkSync(final)
    return result
  }
}
