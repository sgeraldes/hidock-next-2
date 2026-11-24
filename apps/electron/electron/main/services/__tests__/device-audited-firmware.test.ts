import { describe, expect, it } from 'vitest'
import { isAuditedCustomRecordingFirmware, isAuditedNativeRecordingFirmware } from '../device-audited-firmware'

const H1E = 'hidock-h1e'

describe('audited H1E firmware gates', () => {
  it.each([
    [393985, '6.3.1'], [393986, '6.3.2'], [393988, '6.3.4'], [393990, '6.3.6']
  ])('allows custom profile control and native storage on %s/%s', (number, code) => {
    expect(isAuditedCustomRecordingFirmware(H1E, number, code)).toBe(true)
    expect(isAuditedNativeRecordingFirmware(H1E, number, code)).toBe(true)
  })

  it.each([
    [393984, '6.3.0'], [393987, '6.3.3']
  ])('allows native storage but never custom control on stock %s/%s', (number, code) => {
    expect(isAuditedNativeRecordingFirmware(H1E, number, code)).toBe(true)
    expect(isAuditedCustomRecordingFirmware(H1E, number, code)).toBe(false)
  })

  it.each([
    [393989, '6.3.5', 'unknown forward version'],
    [393990, '6.3.5', 'diagnostic number with the original-stock code'],
    [393989, '6.3.6', 'original-stock number with the diagnostic code'],
    [393988, '6.3.6', 'hardened number with the diagnostic code'],
    [393990, '6.3.4', 'diagnostic number with the hardened code'],
    [393991, '6.3.6', 'next number with the diagnostic code'],
    [393990, '6.3.60', 'diagnostic number with a longer code'],
    [393988, '6.3.3', 'candidate number with another code'],
    [393988, '6.3.2', 'candidate number with a custom code'],
    [393986, '6.3.4', 'custom number with the candidate code'],
    [393985, '6.3.2', 'swapped custom pair'],
    [393984, '6.3.1', 'stock number with a custom code'],
    [393987, '6.3.4', 'stock number with the candidate code'],
    [393988, null, 'missing code'],
    [null, '6.3.4', 'missing number'],
    [393988, '', 'empty code'],
    [327714, '1.0.0', 'old firmware']
  ])('denies %s/%s (%s) for both gates', (number, code, _reason) => {
    expect(isAuditedCustomRecordingFirmware(H1E, number, code)).toBe(false)
    expect(isAuditedNativeRecordingFirmware(H1E, number, code)).toBe(false)
  })

  it.each(['hidock-h1', 'hidock-p1', 'hidock-p1-mini', 'hidock-h1-lite', 'unknown', ''])(
    'denies every audited pair on model %s', model => {
      for (const [number, code] of [[393984, '6.3.0'], [393985, '6.3.1'], [393986, '6.3.2'], [393987, '6.3.3'], [393988, '6.3.4'], [393990, '6.3.6']] as const) {
        expect(isAuditedCustomRecordingFirmware(model, number, code)).toBe(false)
        expect(isAuditedNativeRecordingFirmware(model, number, code)).toBe(false)
      }
    })
})
