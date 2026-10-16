// Exact audited H1E (version number, version code) pairs. A pair is the unit of
// trust: a matching number with a different code, another model, or an unlisted
// number such as 393989/6.3.5 is not audited and fails closed.
// 393988/6.3.4 is a prospective pinned candidate, not hardware verified.
// 393992/6.3.8 is a prospective combined slots+VAD candidate: no release, installation or physical approval is implied.
const CUSTOM_CONTROL: ReadonlyArray<readonly [number, string]> = [[393985, '6.3.1'], [393986, '6.3.2'], [393988, '6.3.4'], [393990, '6.3.6'], [393992, '6.3.8']]
const STOCK_NATIVE: ReadonlyArray<readonly [number, string]> = [[393984, '6.3.0'], [393987, '6.3.3']]

const listed = (pairs: ReadonlyArray<readonly [number, string]>, model: string, version: number | null, code: string | null): boolean =>
  model === 'hidock-h1e' && pairs.some(([number, text]) => version === number && code === text)

/** Custom REA1 profile, format and marker-rule control. Never true for stock 6.3.0 or 6.3.3. */
export const isAuditedCustomRecordingFirmware = (model: string, version: number | null, code: string | null): boolean =>
  listed(CUSTOM_CONTROL, model, version, code)

/** Native recording storage and CMD32 marker contract: the custom builds inherit it unchanged. */
export const isAuditedNativeRecordingFirmware = (model: string, version: number | null, code: string | null): boolean =>
  listed(CUSTOM_CONTROL, model, version, code) || listed(STOCK_NATIVE, model, version, code)
