import { app, dialog, Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from 'electron'
import { cpus, totalmem } from 'os'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { backendTrayState, DEFAULT_RESOURCE_LIMITS, OwnedResourceSampler, SustainedResourceAlert, type BackendTrayState, type ResourceLimits, type ResourceReading } from './backend-resources'

export interface BackendTrayActions {
  activeJobs(): number
  isPaused(): boolean
  pause(): void
  resume(): void
  openUi(): void
  quit(): void
  restart(): void
}

interface TraySettings { version: 1; paused: boolean; limits: ResourceLimits }

function stateIcon(state: BackendTrayState) {
  const glyphs: Record<BackendTrayState, string[]> = {
    free: ['01110','10001','10001','10001','01110','00000','00000'],
    working: ['10001','10001','10001','10101','10101','11011','10001'],
    paused: ['11011','11011','11011','11011','11011','11011','11011'],
    'high-usage': ['00100','00100','00100','00100','00100','00000','00100'],
    waiting: ['11111','00001','00010','00100','01000','10000','11111'],
  }
  const colour = state === 'high-usage' ? [40, 120, 255] : state === 'working' ? [255, 170, 40] : [235, 235, 235]
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
    if (glyphs[state][row][column] !== '1') continue
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const offset = ((row * 2 + dy + 1) * 16 + column * 2 + dx + 3) * 4
      pixels[offset] = colour[0]; pixels[offset + 1] = colour[1]; pixels[offset + 2] = colour[2]; pixels[offset + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: 16, height: 16 })
}

/** One tray belongs to the existing backend. No renderer, dashboard, admin
 * service, credential provisioning or remote notifications are involved.
 */
export class BackendTray {
  readonly tray: Tray
  menu: Menu
  private settings: TraySettings
  private readonly settingsPath = join(app.getPath('userData'), 'backend-tray-settings.json')
  private readonly sampler = new OwnedResourceSampler()
  private readonly alert = new SustainedResourceAlert()
  private readonly cores = cpus().length
  private readonly physicalBytes = totalmem()
  private timer: NodeJS.Timeout
  private exitAction: 'restart' | 'quit' | null = null
  private confirming = false
  private destroyed = false
  private reading: ResourceReading = { cpuPercent: null, ramMb: null, ramPercent: null, cpuPartial: true, processCount: 0 }
  private state: BackendTrayState = 'free'
  private lastSampleAt = 0
  private sampleError: string | null = null

  constructor(private readonly actions: BackendTrayActions) {
    this.settings = { version: 1, paused: false, limits: { ...DEFAULT_RESOURCE_LIMITS } }
    if (existsSync(this.settingsPath)) {
      try {
        const saved = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
        if (saved.version !== 1 || typeof saved.paused !== 'boolean' || !this.validLimits(saved.limits)) throw new Error('Invalid tray settings')
        this.settings = saved
      } catch {
        console.warn('[BackendTray] Invalid local settings; new transcription jobs are paused until resumed')
        this.settings.paused = true
      }
    }
    if (this.settings.paused) actions.pause()
    this.tray = new Tray(stateIcon('free'))
    this.menu = Menu.buildFromTemplate([])
    // Explicitly handle both buttons with the same current minimal menu.
    this.tray.on('click', () => this.showMenu())
    this.tray.on('right-click', () => this.showMenu())
    this.tray.on('double-click', () => actions.openUi())
    this.refresh()
    this.timer = setInterval(() => this.refresh(), 5000)
  }

  private validLimits(value: ResourceLimits): boolean {
    return value && Number.isFinite(value.cpuPercent) && value.cpuPercent >= 1 && value.cpuPercent <= 100 && Number.isFinite(value.ramMb) && value.ramMb >= 256 && value.ramMb <= 65536 && Number.isFinite(value.ramPercent) && value.ramPercent >= 1 && value.ramPercent <= 100 && Number.isFinite(value.sustainedMs) && value.sustainedMs >= 5000 && value.sustainedMs <= 60000 && Number.isFinite(value.cooldownMs) && value.cooldownMs >= 60000 && value.cooldownMs <= 3600000
  }

  private save(): void {
    const temp = `${this.settingsPath}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.settings, null, 2), 'utf8')
    renameSync(temp, this.settingsPath)
  }

  pause(): void {
    this.actions.pause()
    this.settings.paused = true
    this.save()
    this.refresh()
  }

  resume(): void {
    if (this.exitAction) return
    this.actions.resume()
    this.settings.paused = false
    this.save()
    this.refresh()
  }

  status() {
    return { state: this.state, paused: this.settings.paused, waitingFor: this.exitAction, resources: { ...this.reading, sampledAt: this.lastSampleAt, error: this.sampleError, logicalCpus: this.cores, scope: 'backend and measurable Electron children; summed working sets', externalAsrWorkersMeasured: false, remoteServersMeasured: false, systemUsageMeasured: false }, limits: { ...this.settings.limits } }
  }

  private resourceText(): string {
    if (this.sampleError) return 'Own-process resource measurement unavailable'
    const cpu = this.reading.cpuPercent === null ? 'warming up' : `${this.reading.cpuPercent.toFixed(1)}%${this.reading.cpuPartial ? ' (partial)' : ''}`
    const ram = this.reading.ramMb === null ? 'unavailable' : `${this.reading.ramMb.toFixed(0)} MB`
    const ramShare = this.reading.ramPercent === null ? 'physical share unavailable' : `${this.reading.ramPercent.toFixed(1)}% physical`
    return `CPU ${cpu} all cores · RAM ${ram} (${ramShare})`
  }

  refresh(): void {
    if (this.destroyed) return
    const paused = this.actions.isPaused()
    if (this.settings.paused !== paused) {
      this.settings.paused = paused
      this.save()
    }
    const now = Date.now()
    if (now - this.lastSampleAt >= 1000) {
      try {
        const ownCpu = process.cpuUsage()
        const metrics = app.getAppMetrics().map(metric => ({ pid: metric.pid, creationTime: metric.creationTime, cpuSeconds: metric.pid === process.pid ? (ownCpu.user + ownCpu.system) / 1000000 : metric.cpu.cumulativeCPUUsage, rssKb: metric.memory.workingSetSize }))
        this.reading = this.sampler.sample(metrics, now, this.cores, this.physicalBytes)
        this.lastSampleAt = now
        this.sampleError = null
      } catch { this.sampleError = 'Local app metrics unavailable' }
    }
    const alert = this.sampleError ? { high: this.alert.high, notify: false } : this.alert.evaluate(this.reading, this.settings.limits, now)
    const active = this.actions.activeJobs()
    this.state = backendTrayState(this.settings.paused, active, alert.high, Boolean(this.exitAction))
    if (alert.notify && Notification.isSupported()) new Notification({ title: 'HiDock: sustained high own-process usage', body: `${this.resourceText()}. External ASR workers and remote servers are not measured. Pause new jobs from the tray if needed.` }).show()
    this.tray.setImage(stateIcon(this.state))
    this.tray.setToolTip(`HiDock ${this.state} · ${active} active · ${this.settings.paused ? 'new jobs paused' : 'accepting directed jobs'}\n${this.resourceText()}\nOwn measured processes, not system usage. External ASR/remote servers excluded.`)
    this.menu = Menu.buildFromTemplate(this.template(active))
    if (this.exitAction && active === 0) this.performExit(this.exitAction)
  }

  showMenu(): void { this.refresh(); if (!this.destroyed) this.tray.popUpContextMenu(this.menu) }

  private limitMenu(key: keyof ResourceLimits, values: number[], suffix: string): MenuItemConstructorOptions[] {
    return values.map(value => ({ id: `limit-${key}-${value}`, label: `${key.endsWith('Ms') ? value / 1000 : value}${suffix}`, type: 'radio', checked: this.settings.limits[key] === value, click: () => { this.settings.limits[key] = value; this.save(); this.refresh() } }))
  }

  private template(active: number): MenuItemConstructorOptions[] {
    return [
      { label: `HiDock: ${this.state} · ${active} active jobs`, enabled: false },
      { label: this.resourceText(), enabled: false },
      { label: 'Backend + measured Electron children; not system usage', enabled: false },
      { label: 'External ASR workers / remote servers not measured', enabled: false },
      { type: 'separator' },
      { id: 'open', label: 'Open HiDock', click: () => this.actions.openUi() },
      { id: 'pause', label: this.settings.paused ? 'Resume directed jobs' : 'Pause new jobs (active work finishes)', enabled: !this.exitAction, click: () => this.settings.paused ? this.resume() : this.pause() },
      { label: 'Local resource alert settings', submenu: [
        { label: 'CPU limit (% of all cores)', submenu: this.limitMenu('cpuPercent', [25, 50, 70, 90], '%') },
        { label: 'RAM limit (summed working sets)', submenu: this.limitMenu('ramMb', [512, 1024, 2048, 4096, 8192], ' MB') },
        { label: 'RAM limit (% of physical capacity)', submenu: this.limitMenu('ramPercent', [10, 25, 50, 75], '%') },
        { label: 'Sustained excess', submenu: this.limitMenu('sustainedMs', [5000, 15000, 30000, 60000], ' seconds') },
        { label: 'Alert cooldown', submenu: this.limitMenu('cooldownMs', [60000, 300000, 900000], ' seconds') },
      ] },
      { type: 'separator' },
      { id: 'restart', label: this.exitAction === 'restart' ? 'Waiting for work to finish before restart…' : 'Restart backend', enabled: !this.exitAction, click: () => { void this.requestExit('restart') } },
      { id: 'quit', label: this.exitAction === 'quit' ? 'Waiting for work to finish before closing…' : 'Quit backend', enabled: !this.exitAction, click: () => { void this.requestExit('quit') } },
      ...(this.exitAction ? [{ label: 'Keep backend running', click: () => { this.exitAction = null; this.refresh() } }] : []),
    ]
  }

  async requestExit(kind: 'restart' | 'quit'): Promise<void> {
    if (this.exitAction || this.confirming) return
    if (this.actions.activeJobs() > 0) {
      this.confirming = true
      try {
        const choice = await dialog.showMessageBox({ type: 'question', title: `HiDock: ${kind}`, message: 'Work is still active.', detail: `Wait for active work to finish, then ${kind}. New transcription jobs will pause. No active work will be silently aborted.`, buttons: [`Wait, then ${kind}`, 'Keep running'], defaultId: 1, cancelId: 1 })
        if (choice.response !== 0) return
        this.pause()
        this.exitAction = kind
        this.refresh()
      } finally { this.confirming = false }
      return
    }
    this.performExit(kind)
  }

  private performExit(kind: 'restart' | 'quit'): void {
    if (this.destroyed) return
    this.actions.pause()
    this.dispose()
    if (kind === 'restart') this.actions.restart()
    else this.actions.quit()
  }

  dispose(): void {
    if (this.destroyed) return
    this.destroyed = true
    clearInterval(this.timer)
    this.tray.destroy()
  }
}
