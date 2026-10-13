/**
 * A recovery launch closes every feature and every device channel except the
 * connection, identity and firmware-install channels. Normal launches are unchanged.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config', () => ({ getConfig: () => ({ features: undefined }) }))

import { FeatureDisabledError, gateInvokeHandler, getResolvedFeatures, isFeatureEnabled } from '../feature-gate'

const original = [...process.argv]
const launch = (...flags: string[]) => { process.argv = [...original, ...flags] }
afterEach(() => { process.argv = [...original] })

const event = {} as never
const OPEN = ['jensen:connect', 'jensen:tryConnect', 'jensen:disconnect', 'jensen:getState', 'jensen:isConnected', 'jensen:getModel',
  'jensen:isP1Device', 'jensen:getDeviceInfo', 'jensen:getCardInfo', 'jensen:getFirmwareUpdatePreflight',
  'jensen:prepareFirmwareInstall', 'jensen:getFirmwareInstallAttempts', 'jensen:executeFirmwareInstall', 'jensen:observeFirmwareInstall']
const CLOSED = ['jensen:listFiles', 'jensen:downloadFile', 'jensen:deleteFile', 'jensen:formatCard', 'jensen:setTime',
  'jensen:setAutoRecord', 'jensen:startRealtime', 'jensen:getFileCount', 'jensen:startBluetoothScan',
  'device-pipeline:sync', 'device-pipeline:connect', 'download-service:queue-downloads', 'deviceCache:saveAll']

describe('recovery launch feature gate', () => {
  it('a normal launch is unchanged', () => {
    launch()
    expect(isFeatureEnabled('device-sync')).toBe(true)
    expect(isFeatureEnabled('transcription')).toBe(true)
    for (const channel of [...OPEN, ...CLOSED]) {
      const handler = vi.fn().mockReturnValue('ok')
      expect(gateInvokeHandler(channel, handler)(event)).toBe('ok')
    }
  })
  it('a recovery launch turns off every feature', () => {
    launch('--recovery-mode')
    for (const feature of Object.values(getResolvedFeatures())) expect(feature.enabled).toBe(false)
    expect(isFeatureEnabled('transcription')).toBe(false)
    expect(isFeatureEnabled('calendar')).toBe(false)
    expect(isFeatureEnabled('assistant')).toBe(false)
  })
  it('a recovery launch without the qualification flag keeps the device closed too', () => {
    launch('--recovery-mode')
    expect(isFeatureEnabled('device-sync')).toBe(false)
    expect(() => gateInvokeHandler('jensen:prepareFirmwareInstall', vi.fn())(event)).toThrow(FeatureDisabledError)
  })
  it('the qualification launch opens only device-sync, and only its connection, identity and firmware channels', () => {
    launch('--recovery-mode', '--firmware-qualification')
    expect(isFeatureEnabled('device-sync')).toBe(true)
    for (const feature of ['transcription', 'calendar', 'assistant', 'meeting-intelligence', 'context-graph'] as const) {
      expect(isFeatureEnabled(feature)).toBe(false)
    }
    for (const channel of OPEN) {
      const handler = vi.fn().mockReturnValue('ok')
      expect(gateInvokeHandler(channel, handler)(event)).toBe('ok')
    }
    for (const channel of CLOSED) {
      const handler = vi.fn()
      expect(() => gateInvokeHandler(channel, handler)(event)).toThrow(FeatureDisabledError)
      expect(handler).not.toHaveBeenCalled()
    }
  })
  it('the qualification flag alone changes nothing', () => {
    launch('--firmware-qualification')
    expect(isFeatureEnabled('device-sync')).toBe(true)
    expect(isFeatureEnabled('transcription')).toBe(true)
    expect(gateInvokeHandler('jensen:listFiles', vi.fn().mockReturnValue('ok'))(event)).toBe('ok')
  })
})
