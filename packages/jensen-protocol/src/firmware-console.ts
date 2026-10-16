/** Read-only bridge ABI with exact source-qualified expected FVER strings.
 * Matching these strings is not physical/image attestation.
 */
export const FIRMWARE_CONSOLE_STATUS = 0xf117
export const FIRMWARE_CONSOLE_MAX_RESPONSE_BYTES = 256
/** Commands advertised by the vectors-capable help module. This is the help list, not the set of allowed requests. */
export const FIRMWARE_CONSOLE_REQUESTS = ['help', 'version', 'uptime', 'vectors'] as const
export type FirmwareConsoleHelpCommand = typeof FIRMWARE_CONSOLE_REQUESTS[number]
/** Every literal the host may send in F117. `slots` is not advertised by any help list. */
export const FIRMWARE_CONSOLE_ALLOWED_REQUESTS = ['help', 'version', 'uptime', 'vectors', 'slots'] as const
export type FirmwareConsoleRequest = typeof FIRMWARE_CONSOLE_ALLOWED_REQUESTS[number]
/** Exact expected FVER strings. Operational qualification is recorded separately; parsing never attests an image. */
export type FirmwareConsoleFirmware = '6.3.2' | '6.3.4' | '6.3.6' | '6.3.7' | '6.3.8'
/** Help list of the original module, before the vectors diagnostic existed. */
const LEGACY_HELP_COMMANDS: readonly FirmwareConsoleHelpCommand[] = ['help', 'version', 'uptime']
/** Three raw 32-bit words printed by the fixed vectors formatter. Not dereferenced, not interpreted, not read atomically. */
export type FirmwareConsoleVectors = { request: 'vectors'; dmaApiWord: number; ringApiWord: number; clockRegisterWord: number; imageAttested: false }
/** Fixed slot 0x0000ef5c plus two raw unsigned 32-bit words. No rate or attestation is derived from them. */
export type FirmwareConsoleSlots = { request: 'slots'; slotAddress: 0x0000ef5c; targetWord: number; pllWord: number; imageAttested: false }
/** Firmware refusal; pWord is uninterpreted and no reason is inferred from it. */
export type FirmwareConsoleSlotsRefusal = { request: 'slots'; refused: true; pWord: number; imageAttested: false }
export type FirmwareConsoleStatus =
  { request: 'help'; commands: FirmwareConsoleHelpCommand[]; imageAttested: false } |
  { request: 'version'; kernelVersion: '1.9.0'; firmwareVersion: FirmwareConsoleFirmware; versionSource: 'candidate-literal'; imageAttested: false } |
  { request: 'uptime'; uptimeMs32: number; counterBits: 32; imageAttested: false } |
  FirmwareConsoleVectors | FirmwareConsoleSlots | FirmwareConsoleSlotsRefusal

const SLOTS_REPLY_BYTES = 40
const SLOTS_REFUSAL_BYTES = 19

export function isFirmwareConsoleRequest(request: unknown): request is FirmwareConsoleRequest {
  return request === 'help' || request === 'version' || request === 'uptime' || request === 'vectors' || request === 'slots'
}

/** Exact ASCII literals, without newline, NUL, shell arguments or arbitrary input. */
export function encodeFirmwareConsoleRequest(request: FirmwareConsoleRequest): Uint8Array {
  if (!isFirmwareConsoleRequest(request)) throw Error('Unsupported firmware console status request')
  return Uint8Array.from(request, character => character.charCodeAt(0))
}

export function parseFirmwareConsoleStatus(request: FirmwareConsoleRequest, body: Uint8Array, expectedFirmware: FirmwareConsoleFirmware = '6.3.2'): FirmwareConsoleStatus | null {
  if (expectedFirmware !== '6.3.2' && expectedFirmware !== '6.3.4' && expectedFirmware !== '6.3.6' && expectedFirmware !== '6.3.7' && expectedFirmware !== '6.3.8') return null
  if (!isFirmwareConsoleRequest(request) || body.length < 2 || body.length > FIRMWARE_CONSOLE_MAX_RESPONSE_BYTES || body[0] !== 0) return null
  if (request === 'slots' && expectedFirmware !== '6.3.7' && expectedFirmware !== '6.3.8') return null
  const textBytes = body.subarray(1)
  if (textBytes.some(byte => byte !== 10 && (byte < 32 || byte > 126))) return null
  const text = Array.from(textBytes, byte => String.fromCharCode(byte)).join('')
  if (request === 'slots') {
    if (text.length === SLOTS_REPLY_BYTES) {
      const words = /^slot=0000ef5c tgt=([0-9a-f]{8}) pll=([0-9a-f]{8})\n$/.exec(text)
      return words ? { request, slotAddress: 0x0000ef5c, targetWord: parseInt(words[1], 16), pllWord: parseInt(words[2], 16), imageAttested: false } : null
    }
    if (text.length === SLOTS_REFUSAL_BYTES) {
      const refusal = /^refused p=([0-9a-f]{8})\n$/.exec(text)
      return refusal ? { request, refused: true, pWord: parseInt(refusal[1], 16), imageAttested: false } : null
    }
    return null
  }
  if (request === 'help') {
    if (text === 'help\nversion\nuptime\n') return { request, commands: [...LEGACY_HELP_COMMANDS], imageAttested: false }
    if (text === 'help\nversion\nuptime\nvectors\n') return { request, commands: [...FIRMWARE_CONSOLE_REQUESTS], imageAttested: false }
    return null
  }
  if (request === 'vectors') {
    const words = /^dma=([0-9a-f]{8}) ring=([0-9a-f]{8}) clk=([0-9a-f]{8})\n$/.exec(text)
    return words
      ? { request, dmaApiWord: parseInt(words[1], 16), ringApiWord: parseInt(words[2], 16), clockRegisterWord: parseInt(words[3], 16), imageAttested: false }
      : null
  }
  if (request === 'version') return text === `kernel=1.9.0 firmware=${expectedFirmware}\n`
    ? { request, kernelVersion: '1.9.0', firmwareVersion: expectedFirmware, versionSource: 'candidate-literal', imageAttested: false } : null
  const match = /^uptime_ms32=(0|[1-9][0-9]{0,9})\n$/.exec(text)
  if (!match) return null
  const uptimeMs32 = Number(match[1])
  return uptimeMs32 <= 0xffffffff ? { request, uptimeMs32, counterBits: 32, imageAttested: false } : null
}
