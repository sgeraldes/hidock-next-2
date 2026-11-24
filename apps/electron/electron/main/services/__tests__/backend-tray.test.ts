// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocked = vi.hoisted(() => ({ path: '', choice: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => mocked.path, getAppMetrics: () => [] },
  dialog: { showMessageBox: mocked.choice },
  Menu: { buildFromTemplate: (items: unknown[]) => ({ items }) },
  nativeImage: { createFromBitmap: () => ({}) },
  Notification: { isSupported: () => false },
  Tray: class extends EventEmitter { popUpContextMenu = vi.fn(); setImage = vi.fn(); setToolTip = vi.fn(); destroy = vi.fn() },
}))
import { BackendTray } from '../backend-tray'
describe('backend tray controls', () => {
  let tray: BackendTray
  let paused: boolean
  let active: number
  let actions: ConstructorParameters<typeof BackendTray>[0]
  beforeEach(() => {
    mocked.path = mkdtempSync(join(tmpdir(), 'hidock-tray-test-'))
    paused = false; active = 0
    actions = { activeJobs: () => active, isPaused: () => paused, pause: vi.fn(() => { paused = true }), resume: vi.fn(() => { paused = false }), openUi: vi.fn(), quit: vi.fn(), restart: vi.fn() }
    tray = new BackendTray(actions)
  })
  afterEach(() => { tray.dispose(); rmSync(mocked.path, { recursive: true, force: true }); vi.clearAllMocks() })
  it('opens the same menu from either button and persists explicit pause/resume', () => {
    tray.tray.emit('click'); tray.tray.emit('right-click')
    expect(tray.tray.popUpContextMenu).toHaveBeenCalledTimes(2)
    tray.pause(); expect(tray.status().paused).toBe(true)
    tray.resume(); expect(tray.status().paused).toBe(false)
    expect(JSON.parse(readFileSync(join(mocked.path, 'backend-tray-settings.json'), 'utf8')).paused).toBe(false)
    paused = true; tray.refresh(); expect(tray.status().paused).toBe(true)
  })
  it('keeps active work running when the safe dialog choice is declined', async () => {
    active = 1; mocked.choice.mockResolvedValue({ response: 1 })
    await tray.requestExit('quit')
    expect(actions.quit).not.toHaveBeenCalled(); expect(actions.pause).not.toHaveBeenCalled()
  })
  it('waits for active work before restarting and leaves new jobs paused', async () => {
    active = 1; mocked.choice.mockResolvedValue({ response: 0 })
    await tray.requestExit('restart')
    expect(tray.status().waitingFor).toBe('restart'); expect(actions.restart).not.toHaveBeenCalled()
    active = 0; tray.refresh(); expect(actions.restart).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(join(mocked.path, 'backend-tray-settings.json'), 'utf8')).paused).toBe(true)
  })
  it('quits an idle backend without an active-work dialog', async () => {
    await tray.requestExit('quit')
    expect(mocked.choice).not.toHaveBeenCalled(); expect(actions.quit).toHaveBeenCalledTimes(1)
  })
})
