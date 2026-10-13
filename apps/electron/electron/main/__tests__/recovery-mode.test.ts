// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFirmwareQualificationLaunch, isRecoveryMode } from '../recovery-mode'

const original = [...process.argv]
const launch = (...flags: string[]) => { process.argv = [...original, ...flags] }
afterEach(() => { process.argv = [...original]; vi.unstubAllEnvs() })

describe('recovery and firmware qualification launch flags', () => {
  it('a normal launch is neither', () => {
    launch()
    expect(isRecoveryMode()).toBe(false)
    expect(isFirmwareQualificationLaunch()).toBe(false)
  })
  it('the qualification flag alone enables nothing', () => {
    launch('--firmware-qualification')
    expect(isFirmwareQualificationLaunch()).toBe(false)
  })
  it('recovery mode alone does not qualify', () => {
    launch('--recovery-mode')
    expect(isRecoveryMode()).toBe(true)
    expect(isFirmwareQualificationLaunch()).toBe(false)
  })
  it('recovery mode plus the qualification flag qualifies', () => {
    launch('--recovery-mode', '--firmware-qualification')
    expect(isFirmwareQualificationLaunch()).toBe(true)
  })
  it('the environment form of recovery mode also qualifies', () => {
    vi.stubEnv('HIDOCK_RECOVERY_MODE', '1')
    launch('--firmware-qualification')
    expect(isFirmwareQualificationLaunch()).toBe(true)
  })
})
