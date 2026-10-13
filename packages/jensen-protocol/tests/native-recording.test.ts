// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CMD, JensenDevice, USB_PRODUCT_IDS, setJensenLogging } from '../src/jensen-device.js'
import { parseNativeRecordingCommandAck, parseNativeRecordingStatusPayload } from '../src/native-recording.js'
import { encodeCustomMarkerRules } from '../src/custom-marker-rules.js'

function statusBody(type: number, filename: string, seconds: number, levels: number[]): Uint8Array {
  return Uint8Array.from([type, filename.length, ...Array.from(filename, char => char.charCodeAt(0)),
    seconds >>> 8, seconds & 255, levels.length, ...levels])
}

function packet(command: number, sequence: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + body.length)
  const header = new DataView(bytes.buffer)
  header.setUint16(0, 0x1234)
  header.setUint16(2, command)
  header.setUint32(4, sequence)
  header.setUint32(8, body.length)
  bytes.set(body, 12)
  return bytes
}

describe('bounded H1E6.3 CMD29 payload', () => {
  it('preserves unsigned levels and BE16 elapsed seconds without assigning physical channels', () => {
    expect(parseNativeRecordingStatusPayload(statusBody(0, '20261011-120000-Rec.mp3', 0x81fe, [0, 128, 255]))).toEqual({
      recording: '20261011-120000-Rec.mp3', duration: 33278, samples: [0, 128, 255], type: 'recording',
    })
  })

  it('accepts known whisper type1, zero elapsed time and no samples', () => {
    expect(parseNativeRecordingStatusPayload(statusBody(1, 'Whisper.mp3', 0, []))).toEqual({
      recording: 'Whisper.mp3', duration: 0, samples: [], type: 'whisper',
    })
  })

  it('represents an empty successful reply without treating missing/malformed bytes as idle', () => {
    expect(parseNativeRecordingStatusPayload(new Uint8Array())).toEqual({ recording: null, duration: 0, samples: [], type: null })
  })

  const complete = statusBody(0, 'known.mp3', 256, [0, 1, 255])
  it.each(Array.from({ length: complete.length - 1 }, (_, index) => index + 1))('rejects truncated active body of length %i', length => {
    expect(parseNativeRecordingStatusPayload(complete.subarray(0, length))).toBeNull()
  })

  it.each([2, 127, 255])('rejects unknown type %i', type => {
    expect(parseNativeRecordingStatusPayload(statusBody(type, 'a.mp3', 1, []))).toBeNull()
  })

  it('rejects empty and NUL-bearing active filenames, trailing bytes and dishonest counts', () => {
    expect(parseNativeRecordingStatusPayload(statusBody(0, '', 0, []))).toBeNull()
    expect(parseNativeRecordingStatusPayload(statusBody(0, '\0', 0, []))).toBeNull()
    expect(parseNativeRecordingStatusPayload(Uint8Array.from([...complete, 3]))).toBeNull()
    const wrongFilenameCount = complete.slice()
    wrongFilenameCount[1] = 255
    expect(parseNativeRecordingStatusPayload(wrongFilenameCount)).toBeNull()
    const wrongLevelCount = complete.slice()
    wrongLevelCount[2 + 'known.mp3'.length + 2] = 255
    expect(parseNativeRecordingStatusPayload(wrongLevelCount)).toBeNull()
  })

  it('bounds both one-byte counts and copies levels from reused response memory', () => {
    const maximum = statusBody(0, 'a'.repeat(255), 65535, Array(255).fill(255))
    expect(maximum.length).toBe(515)
    const parsed = parseNativeRecordingStatusPayload(maximum)
    expect(parsed?.duration).toBe(65535)
    expect(parsed?.recording?.length).toBe(255)
    expect(parsed?.samples).toHaveLength(255)
    maximum.fill(0)
    expect(parsed?.samples[0]).toBe(255)
    expect(parsed?.recording?.length).toBe(255)
    expect(parseNativeRecordingStatusPayload(new Uint8Array(516))).toBeNull()
  })
})

describe('native control ACK has no persistence proof', () => {
  it('reports queue acknowledgment separately from persistence', () => {
    expect(parseNativeRecordingCommandAck(Uint8Array.of(0))).toEqual({ result: 'success', acknowledgement: 'queued', persistence: 'unverified' })
    expect(parseNativeRecordingCommandAck(Uint8Array.of(1))).toEqual({ result: 'failed', acknowledgement: 'rejected', persistence: 'unverified' })
    expect(parseNativeRecordingCommandAck(Uint8Array.of(255))?.result).toBe('failed')
    expect(parseNativeRecordingCommandAck(new Uint8Array())).toBeNull()
    expect(parseNativeRecordingCommandAck(Uint8Array.of(0, 0))).toBeNull()
  })
})

// Injected transport exercises the real Jensen frame builder, command queue,
// read-loop ingestion and registered reply handlers. No real device is opened.
describe('native recording commands through the actual protocol queue', () => {
  const devices: JensenDevice[] = []
  afterEach(async () => {
    vi.useRealTimers()
    for (const device of devices.splice(0)) await device.disconnect()
    setJensenLogging(() => true)
  })

  async function harness() {
    vi.useFakeTimers()
    setJensenLogging(() => false)
    const endpoint = Object.assign(new EventEmitter(), {
      startPoll: vi.fn(), stopPoll: vi.fn((callback?: () => void) => callback?.()),
    })
    const transferOut = vi.fn(async (_endpoint: number, data: BufferSource) => ({ status: 'ok', bytesWritten: data.byteLength }))
    const usbDevice = {
      vendorId: 0x10d6, productId: USB_PRODUCT_IDS.H1E, productName: 'HiDock H1E', opened: true,
      open: vi.fn(async () => {}), selectConfiguration: vi.fn(async () => {}),
      claimInterface: vi.fn(async () => {}), selectAlternateInterface: vi.fn(async () => {}),
      transferOut, transferIn: vi.fn(() => new Promise(() => {})),
      close: vi.fn(async () => {}), reset: vi.fn(async () => {}),
      device: { interface: () => ({ endpoint: () => endpoint }) },
    } as unknown as USBDevice
    const usb = { getDevices: async () => [], requestDevice: async () => usbDevice,
      addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as USB
    const device = new JensenDevice(usb)
    devices.push(device)
    const connecting = device.tryConnect(usbDevice)
    await vi.advanceTimersByTimeAsync(350)
    expect(await connecting).toBe(true)
    expect(device.getModel()).toBe('hidock-h1e')
    device.versionNumber = 393984
    device.versionCode = '6.3.0'
    await vi.advanceTimersByTimeAsync(0)
    const sent = () => transferOut.mock.calls.map(call => new Uint8Array(call[1] as Uint8Array))
    const reply = async (body: Uint8Array, fragment = false) => {
      const request = sent().at(-1)!
      const header = new DataView(request.buffer, request.byteOffset, request.byteLength)
      const response = packet(header.getUint16(2), header.getUint32(4), body)
      if (fragment) {
        endpoint.emit('data', response.subarray(0, 9))
        await vi.advanceTimersByTimeAsync(15)
        endpoint.emit('data', response.subarray(9))
      } else endpoint.emit('data', response)
      await vi.advanceTimersByTimeAsync(15)
    }
    return { device, transferOut, sent, reply }
  }

  it('sends empty CMD29, receives a fragmented framed response and parses actual handler output', async () => {
    const h = await harness()
    const pending = h.device.getRecordingStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(Array.from(h.sent()[0].subarray(0, 4))).toEqual([0x12, 0x34, 0, 29])
    expect(h.sent()[0]).toHaveLength(12)
    await h.reply(statusBody(0, 'a.mp3', 258, [0, 255]), true)
    await expect(pending).resolves.toEqual({ recording: 'a.mp3', duration: 258, samples: [0, 255], type: 'recording' })
  })

  it.each([393984, 393985, 393986, 393987, 393988, 393989])('keeps custom file-list durations unknown until media readback (version=%s)', async version => {
    const h = await harness()
    h.device.versionNumber = version; h.device.versionCode = `6.3.${version - 393984}`
    const custom = version === 393985 || version === 393986 || version === 393988
    const pending = h.device.listFiles(undefined, 1)
    await vi.advanceTimersByTimeAsync(0)
    const name = '2026Oct11-120000-Rec.wav'
    const body = Uint8Array.from([255, 255, 0, 0, 0, 1, 3, 0, 0, name.length,
      ...Array.from(name, char => char.charCodeAt(0)), 0, 9, 196, 44, ...Array(22).fill(0)])
    await h.reply(body, true)
    const files = await pending
    expect(files).toHaveLength(1)
    expect(files?.[0].duration).toBe(custom ? 0 : 53)
  })

  it('does not query or set custom profiles on official stock firmware', async () => {
    const h = await harness()
    await expect(h.device.getCustomRecordingProfile()).resolves.toBeNull()
    await expect(h.device.setCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })).resolves.toBeNull()
    await expect(h.device.getCustomRecordingFormat()).resolves.toBeNull()
    await expect(h.device.setCustomRecordingFormat('wav')).resolves.toBeNull()
    await expect(h.device.getCustomMarkerRules()).resolves.toBeNull()
    await expect(h.device.setCustomMarkerRules({ enabled: false, lane: 2, meanMagnitudeThreshold: 1000 })).resolves.toBeNull()
    expect(h.sent()).toHaveLength(0)
  })

  it.each([393985, 393986, 393988])('qualifies the strict custom response before a single exact profile write (version=%s)', async version => {
    const h = await harness()
    h.device.versionNumber = version
    h.device.versionCode = `6.3.${version - 393984}`
    const record = Uint8Array.from([82, 69, 65, 49, 2, 0, 0, 0, 0, 0, 128, 0, 0, 0, 128, 0])
    const pending = h.device.setCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })
    await vi.advanceTimersByTimeAsync(0)
    expect(Array.from(h.sent()[0].subarray(2, 4))).toEqual([0xf1, 0x11])
    await h.reply(Uint8Array.of(1, ...record), true)
    expect(h.sent()).toHaveLength(2)
    expect(Array.from(h.sent()[1].subarray(2, 4))).toEqual([0xf1, 0x10])
    expect(Array.from(h.sent()[1].subarray(12))).toEqual(Array.from(record))
    await h.reply(Uint8Array.of(0))
    await expect(pending).resolves.toEqual({ result: 'success', persistence: 'unverified' })
  })

  it.each([393985, 393986, 393988])('rejects malformed custom capability bytes before any profile mutation (version=%s)', async version => {
    const h = await harness()
    h.device.versionNumber = version
    h.device.versionCode = `6.3.${version - 393984}`
    const pending = h.device.setCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })
    await vi.advanceTimersByTimeAsync(0)
    await h.reply(Uint8Array.of(0))
    await expect(pending).resolves.toBeNull()
    expect(h.sent()).toHaveLength(1)
  })

  it.each([[393985, true], [393985, false], [393986, true], [393986, false], [393988, true], [393988, false]])('requires the optional REF1 reply before a format write (version=%s supported=%s)', async (version, supported) => {
    const h = await harness()
    h.device.versionNumber = version as number
    h.device.versionCode = `6.3.${(version as number) - 393984}`
    const pending = h.device.setCustomRecordingFormat('wav')
    await vi.advanceTimersByTimeAsync(0)
    const profile = Uint8Array.from([82, 69, 65, 49, 2, 0, 0, 0, 0, 0, 128, 0, 0, 0, 128, 0])
    await h.reply(Uint8Array.of(1, ...profile))
    expect(Array.from(h.sent()[1].subarray(2, 4))).toEqual([0xf1, 0x14])
    await h.reply(supported ? Uint8Array.of(1, 82, 69, 70, 49, 0, 0, 0, 0) : new Uint8Array())
    if (!supported) {
      await expect(pending).resolves.toBeNull()
      expect(h.sent()).toHaveLength(2)
    } else {
      expect(Array.from(h.sent()[2].subarray(2, 4))).toEqual([0xf1, 0x13])
      expect(Array.from(h.sent()[2].subarray(12))).toEqual([82, 69, 70, 49, 1, 0, 0, 0])
      await h.reply(Uint8Array.of(0))
      await expect(pending).resolves.toEqual({ result: 'success', persistence: 'unverified' })
    }
  })

  it.each([393985, 393986, 393988])('requires a strict custom capability reply before a native marker on the experimental version (version=%s)', async version => {
    const h = await harness()
    h.device.versionNumber = version
    h.device.versionCode = `6.3.${version - 393984}`
    const pending = h.device.addNativeMarker()
    await vi.advanceTimersByTimeAsync(0)
    expect(Array.from(h.sent()[0].subarray(2, 4))).toEqual([0xf1, 0x11])
    await h.reply(Uint8Array.of(0))
    await expect(pending).resolves.toBeNull()
    expect(h.sent()).toHaveLength(1)
  })

  it.each([[393985, true], [393985, false], [393986, true], [393986, false], [393988, true], [393988, false]])('qualifies rule support before one exact CRC-protected write (version=%s supported=%s)', async (version, supported) => {
    const h = await harness()
    h.device.versionNumber = version as number
    h.device.versionCode = `6.3.${(version as number) - 393984}`
    const rules = { enabled: false, lane: 2 as const, meanMagnitudeThreshold: 1000 }
    const pending = h.device.setCustomMarkerRules(rules)
    await vi.advanceTimersByTimeAsync(0)
    const profile = Uint8Array.from([82, 69, 65, 49, 2, 0, 0, 0, 0, 0, 128, 0, 0, 0, 128, 0])
    await h.reply(Uint8Array.of(1, ...profile))
    expect(Array.from(h.sent()[1].subarray(2, 4))).toEqual([0xf1, 0x16])
    const record = encodeCustomMarkerRules(rules)
    await h.reply(supported ? Uint8Array.of(1, ...record) : Uint8Array.of(0))
    if (!supported) {
      await expect(pending).resolves.toBeNull()
      expect(h.sent()).toHaveLength(2)
    } else {
      expect(h.sent()[2]).toHaveLength(48)
      expect(Array.from(h.sent()[2].subarray(2, 4))).toEqual([0xf1, 0x15])
      expect(Array.from(h.sent()[2].subarray(12))).toEqual(Array.from(record))
      await h.reply(Uint8Array.of(0))
      await expect(pending).resolves.toEqual({ result: 'success', persistence: 'unverified' })
    }
  })

  it.each([393985, 393986, 393988])('preserves native marker framing after qualifying the experimental firmware (version=%s)', async version => {
    const h = await harness()
    h.device.versionNumber = version
    h.device.versionCode = `6.3.${version - 393984}`
    const pending = h.device.addNativeMarker()
    await vi.advanceTimersByTimeAsync(0)
    const record = Uint8Array.from([82, 69, 65, 49, 2, 0, 0, 0, 0, 0, 128, 0, 0, 0, 128, 0])
    await h.reply(Uint8Array.of(1, ...record))
    expect(h.sent()).toHaveLength(2)
    expect(Array.from(h.sent()[1].subarray(2, 4))).toEqual([0, 28])
    expect(Array.from(h.sent()[1].subarray(12))).toEqual([1, 3])
    await h.reply(Uint8Array.of(0))
    await expect(pending).resolves.toEqual({ result: 'success', acknowledgement: 'queued', persistence: 'unverified' })
  })

  it('returns the inactive shape only for an actual empty framed CMD29 response', async () => {
    const h = await harness()
    const pending = h.device.getRecordingStatus()
    await vi.advanceTimersByTimeAsync(0)
    await h.reply(new Uint8Array())
    await expect(pending).resolves.toEqual({ recording: null, duration: 0, samples: [], type: null })
  })

  it.each([3, 4, -1, 1.5, Number.NaN])('rejects unsafe live channel count %s before any USB command', async mode => {
    const h = await harness()
    await expect(h.device.startRealtime(mode)).resolves.toBeNull()
    expect(h.sent()).toHaveLength(0)
  })

  it('settles a malformed reply as null immediately, then unblocks the next command', async () => {
    const h = await harness()
    const first = h.device.getRecordingStatus()
    const second = h.device.addNativeMarker()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent()).toHaveLength(1)
    await h.reply(Uint8Array.of(0, 255))
    await expect(first).resolves.toBeNull()
    expect(h.sent()).toHaveLength(2)
    expect(Array.from(h.sent()[1].subarray(12))).toEqual([1, 3])
    await h.reply(Uint8Array.of(0))
    await expect(second).resolves.toEqual({ result: 'success', acknowledgement: 'queued', persistence: 'unverified' })
  })

  it('serializes named marker and toggle controls, sends exact bodies once and preserves queued-only ACK semantics', async () => {
    const h = await harness()
    const marker = h.device.addNativeMarker()
    const toggle = h.device.toggleNativeRecording()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent()).toHaveLength(1)
    expect(h.sent()[0][3]).toBe(CMD.SEND_KEY_CODE)
    expect(Array.from(h.sent()[0].subarray(12))).toEqual([1, 3])
    await h.reply(Uint8Array.of(0))
    await expect(marker).resolves.toMatchObject({ result: 'success', acknowledgement: 'queued', persistence: 'unverified' })
    expect(h.sent()).toHaveLength(2)
    expect(Array.from(h.sent()[1].subarray(12))).toEqual([2, 3])
    await h.reply(Uint8Array.of(1))
    await expect(toggle).resolves.toMatchObject({ result: 'failed', acknowledgement: 'rejected', persistence: 'unverified' })
  })

  it('settles a malformed CMD28 ACK as unknown instead of success and never retries it', async () => {
    const h = await harness()
    const pending = h.device.addNativeMarker()
    await vi.advanceTimersByTimeAsync(0)
    await h.reply(Uint8Array.of(0, 0))
    await expect(pending).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.sent()).toHaveLength(1)
  })

  it('times out an unacknowledged toggle once without retrying or claiming failure/idle persistence', async () => {
    const h = await harness()
    const pending = h.device.toggleNativeRecording(1)
    await vi.advanceTimersByTimeAsync(1001)
    await expect(pending).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.sent()).toHaveLength(1)
  })

  it.each([
    ['hidock-h1e', 393733, '6.2.5'], ['hidock-h1e', 393988, '6.3.2'], ['hidock-h1e', 393989, '6.3.4'], ['hidock-h1e', 393990, '6.3.6'],
    ['hidock-h1e', 397568, '6.17.0'], ['hidock-h1e', 393984, null],
    ['hidock-h1e', null, '6.3.0'], ['hidock-h1e', 393984, '6.2.5'],
    ['hidock-h1', 393984, '6.3.0'], ['unknown', 393984, '6.3.0'],
  ] as const)('refuses unqualified identity %s / %s / %s before sending anything', async (model, version, code) => {
    const h = await harness()
    ;(h.device as unknown as { model: string }).model = model
    h.device.versionNumber = version
    h.device.versionCode = code
    await expect(h.device.getRecordingStatus()).resolves.toBeNull()
    await expect(h.device.addNativeMarker()).resolves.toBeNull()
    await expect(h.device.toggleNativeRecording()).resolves.toBeNull()
    expect(h.sent()).toHaveLength(0)
  })

  it('uses only original native control on forward stock and rejects every custom control without OUT', async () => {
    const h = await harness(); h.device.versionNumber = 393987; h.device.versionCode = '6.3.3'
    expect(await h.device.getCustomRecordingProfile()).toBeNull()
    expect(await h.device.setCustomRecordingProfile({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })).toBeNull()
    expect(await h.device.getCustomRecordingFormat()).toBeNull(); expect(await h.device.setCustomRecordingFormat('wav')).toBeNull()
    expect(await h.device.getCustomMarkerRules()).toBeNull()
    expect(await h.device.setCustomMarkerRules({ enabled: false, lane: 2, meanMagnitudeThreshold: 1000 })).toBeNull()
    expect(await h.device.getFirmwareConsoleStatus('help')).toBeNull()
    expect(h.device.createOwnedScratchUploadSession(1, 2, 512, 3)).toBeNull()
    expect(h.sent()).toHaveLength(0)
    const status = h.device.getRecordingStatus(); await vi.advanceTimersByTimeAsync(0)
    expect(new DataView(h.sent()[0].buffer).getUint16(2)).toBe(29)
    await h.reply(new Uint8Array()); expect(await status).toMatchObject({ recording: null })
    const marker = h.device.addNativeMarker(); await vi.advanceTimersByTimeAsync(0)
    expect(new DataView(h.sent()[1].buffer).getUint16(2)).toBe(28)
    await h.reply(Uint8Array.of(0)); expect(await marker).toMatchObject({ result: 'success' })
  })

  it('rechecks firmware when a queued mutation acquires the lock', async () => {
    const h = await harness()
    const pending = h.device.getRecordingStatus()
    const queued = h.device.addNativeMarker()
    await vi.advanceTimersByTimeAsync(0)
    h.device.versionCode = '6.17.0'
    h.device.versionNumber = 397568
    await h.reply(statusBody(0, 'a.mp3', 1, []))
    await expect(pending).resolves.toMatchObject({ recording: 'a.mp3' })
    await expect(queued).resolves.toBeNull()
    expect(h.sent()).toHaveLength(1)
  })

  it.each([0, -1, Infinity, NaN, 31])('rejects an unbounded/invalid timeout %s before sending', async timeout => {
    const h = await harness()
    await expect(h.device.getRecordingStatus(timeout)).resolves.toBeNull()
    await expect(h.device.addNativeMarker(timeout)).resolves.toBeNull()
    await expect(h.device.toggleNativeRecording(timeout)).resolves.toBeNull()
    expect(h.sent()).toHaveLength(0)
  })

  it('returns unknown immediately when disconnected and exposes no arbitrary sendKeyCode method', async () => {
    const device = new JensenDevice({ addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as USB)
    await expect(device.getRecordingStatus()).resolves.toBeNull()
    await expect(device.addNativeMarker()).resolves.toBeNull()
    await expect(device.toggleNativeRecording()).resolves.toBeNull()
    expect('sendKeyCode' in device).toBe(false)
  })
})
