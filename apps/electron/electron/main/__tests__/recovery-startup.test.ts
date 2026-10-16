// @vitest-environment node
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ disableHardwareAcceleration: vi.fn(),
  appendSwitch: vi.fn(), state: { earlyConfigurationApplied: false } }))
vi.mock('electron', () => ({ app: { disableHardwareAcceleration: mocks.disableHardwareAcceleration,
  commandLine: { appendSwitch: mocks.appendSwitch }, getPath: () => 'test-profile', setPath: vi.fn() } }))
vi.mock('../startup-state', () => ({ getStartupState: () => mocks.state }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('fs', () => ({ existsSync: () => false }))
import { configureEarlyStartup } from '../startup-configuration'
it('recovery disables hardware drawing before windows, retaining software painting', () => {
  vi.stubEnv('HIDOCK_RECOVERY_MODE', '1')
  try {
    configureEarlyStartup()
    expect(mocks.disableHardwareAcceleration).toHaveBeenCalledOnce()
    expect(mocks.appendSwitch).not.toHaveBeenCalledWith('disable-software-rasterizer')
  } finally { vi.unstubAllEnvs() }
})
