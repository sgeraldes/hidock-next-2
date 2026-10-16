// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFirmwareQualificationLaunch, isFirmwareStockRecoveryLaunch } from '../recovery-mode'

const original = [...process.argv]
const launch = (...flags: string[]) => { process.argv = [...original, ...flags] }
afterEach(() => { process.argv = [...original]; vi.unstubAllEnvs() })

describe('firmware launch flags', () => {
  it('normal app launch enables neither qualification nor stock recovery', () => {
    launch()
    expect(isFirmwareQualificationLaunch()).toBe(false)
    expect(isFirmwareStockRecoveryLaunch()).toBe(false)
  })
  it('stock recovery flag alone enables nothing', () => {
    launch('--firmware-stock-recovery')
    expect(isFirmwareStockRecoveryLaunch()).toBe(false)
  })
  it('recovery mode plus stock flag without qualification enables nothing', () => {
    launch('--recovery-mode', '--firmware-stock-recovery')
    expect(isFirmwareQualificationLaunch()).toBe(false)
    expect(isFirmwareStockRecoveryLaunch()).toBe(false)
  })
  it('qualification launch without the explicit stock flag leaves stock recovery off', () => {
    launch('--recovery-mode', '--firmware-qualification')
    expect(isFirmwareQualificationLaunch()).toBe(true)
    expect(isFirmwareStockRecoveryLaunch()).toBe(false)
  })
  it('qualification launch plus stock flag enables stock recovery', () => {
    launch('--recovery-mode', '--firmware-qualification', '--firmware-stock-recovery')
    expect(isFirmwareStockRecoveryLaunch()).toBe(true)
  })
  it('environment recovery mode with both flags also qualifies', () => {
    vi.stubEnv('HIDOCK_RECOVERY_MODE', '1')
    launch('--firmware-qualification', '--firmware-stock-recovery')
    expect(isFirmwareStockRecoveryLaunch()).toBe(true)
  })
  it.each(['--device-validation', '--firmware-read-only'])('%s disables qualification and therefore stock recovery', flag => {
    launch('--recovery-mode', '--firmware-qualification', '--firmware-stock-recovery', flag)
    expect(isFirmwareQualificationLaunch()).toBe(false)
    expect(isFirmwareStockRecoveryLaunch()).toBe(false)
  })
})
