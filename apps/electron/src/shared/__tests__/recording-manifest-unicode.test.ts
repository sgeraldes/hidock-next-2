// @vitest-environment node
import { expect, it } from 'vitest'
import { assertRecordingManifestBinding, parseRecordingManifest } from '../recording-manifest'

const sha = 'a'.repeat(64)
const fixture = (): any => ({
  schemaVersion: 1, recordingId: 'Device-Id', contentGeneration: 'Generation-A', state: 'finalized',
  file: { name: 'capture.wav', byteLength: 64044, sha256: sha },
  audio: {
    container: 'wav', codec: 'pcm_s16le', sampleRateHz: 16000, channels: 2, bitsPerSample: 16,
    clock: null,
    sourceMap: [{ channelIndex: 0, role: 'unknown' }, { channelIndex: 1, role: 'unknown' }]
  },
  markers: []
})
const marker = (overrides: object) => ({
  markerId: 'm1', type: 'manual', position: { unit: 'legacy-ms', value: 1 }, ...overrides
})

type Field = [name: string, apply: (input: any, value: string) => void]
const fields: Field[] = [
  ['recordingId', (input, value) => { input.recordingId = value }],
  ['contentGeneration', (input, value) => { input.contentGeneration = value }],
  ['file.name', (input, value) => { input.file.name = value }],
  ['markerId', (input, value) => { input.markers = [marker({ markerId: value })] }],
  ['label', (input, value) => { input.markers = [marker({ label: value })] }]
]

const malformed: Array<[string, string]> = [
  ['lone high surrogate', 'id-\uD800'],
  ['lone low surrogate', 'id-\uDC00'],
  ['high surrogate followed by a non-surrogate', '\uD83Dx'],
  ['reversed pair (low then high)', '\uDE00\uD83D'],
  ['two high surrogates in a row', '\uD83D😀'],
  ['high surrogate at the end after a valid pair', '😀\uD83D']
]

for (const [fieldName, apply] of fields) {
  for (const [description, value] of malformed) {
    it(`rejects ${description} in ${fieldName} when written as a JSON escape`, () => {
      const input = fixture()
      apply(input, value)
      const payload = JSON.stringify(input)
      expect(payload).toContain('\\u') // JSON.stringify emits a well-formed escape for lone surrogates.
      expect(() => parseRecordingManifest(payload)).toThrow('invalid')
    })

    it(`rejects ${description} in ${fieldName} when the raw surrogate sits inside the payload text`, () => {
      const input = fixture()
      apply(input, 'PLACEHOLDER')
      const payload = JSON.stringify(input).replace('PLACEHOLDER', value)
      expect(() => parseRecordingManifest(payload)).toThrow('invalid')
    })
  }
}

it('rejects a hand-written \\uD800 escape that JSON.parse turns into a lone surrogate', () => {
  const payload = JSON.stringify(fixture()).replace('Device-Id', 'id-\\uD800')
  expect(payload).toContain('id-\\uD800')
  expect(() => parseRecordingManifest(payload)).toThrow('invalid')
})

it('rejects a raw lone surrogate anywhere in the payload, even inside an unknown key', () => {
  const payload = JSON.stringify(fixture()).replace('"markers"', '"mark\uD800ers"')
  expect(() => parseRecordingManifest(payload)).toThrow('invalid')
})

it('accepts a hand-written escaped surrogate pair and returns the combined scalar', () => {
  const payload = JSON.stringify(fixture()).replace('Device-Id', 'id-\\uD83D\\uDE00')
  expect(parseRecordingManifest(payload).recordingId).toBe('id-😀')
})

it('returns well-formed Unicode exactly as given, with no case folding or normalization', () => {
  const values = ['😀', 'Éé', 'é', 'é', 'ǅ', 'ß', 'İ', 'ﬁ', '𝔘', '\u{10FFFF}', '￿', '�']
  for (const value of values) {
    const input = fixture()
    input.recordingId = `R-${value}`
    input.contentGeneration = `G-${value}`
    input.file.name = `${value}.wav`
    input.markers = [marker({ markerId: `M-${value}`, label: value })]
    const parsed = parseRecordingManifest(JSON.stringify(input))
    expect(parsed.recordingId).toBe(`R-${value}`)
    expect(parsed.contentGeneration).toBe(`G-${value}`)
    expect(parsed.file.name).toBe(`${value}.wav`)
    expect(parsed.markers[0].markerId).toBe(`M-${value}`)
    expect(parsed.markers[0].label).toBe(value)
  }
})

it('keeps NFC and NFD forms of the same text as distinct identifiers', () => {
  const nfc = fixture()
  nfc.contentGeneration = 'é'
  const nfd = fixture()
  nfd.contentGeneration = 'é'
  const a = parseRecordingManifest(JSON.stringify(nfc)).contentGeneration
  const b = parseRecordingManifest(JSON.stringify(nfd)).contentGeneration
  expect(a).not.toBe(b)
  expect(Buffer.from(a, 'utf8').length).toBe(2)
  expect(Buffer.from(b, 'utf8').length).toBe(3)
})

it('measures identifier bounds in UTF-8 bytes (128), not UTF-16 units', () => {
  const cases: Array<[string, number]> = [['a', 1], ['é', 2], ['€', 3], ['😀', 4]]
  for (const [unit, size] of cases) {
    const atLimit = fixture()
    atLimit.recordingId = unit.repeat(Math.floor(128 / size))
    const filler = 128 - Buffer.byteLength(atLimit.recordingId, 'utf8')
    atLimit.recordingId += 'a'.repeat(filler)
    expect(Buffer.byteLength(atLimit.recordingId, 'utf8')).toBe(128)
    expect(parseRecordingManifest(JSON.stringify(atLimit)).recordingId).toBe(atLimit.recordingId)

    const overLimit = fixture()
    overLimit.recordingId = `${atLimit.recordingId}a`
    expect(() => parseRecordingManifest(JSON.stringify(overLimit))).toThrow('invalid')
  }
})

it('measures file name bounds in UTF-8 bytes (255)', () => {
  const atLimit = fixture()
  atLimit.file.name = `${'😀'.repeat(63)}abc` // 252 + 3
  expect(Buffer.byteLength(atLimit.file.name, 'utf8')).toBe(255)
  expect(parseRecordingManifest(JSON.stringify(atLimit)).file.name).toBe(atLimit.file.name)

  const overLimit = fixture()
  overLimit.file.name = `${atLimit.file.name}a`
  expect(() => parseRecordingManifest(JSON.stringify(overLimit))).toThrow('invalid')

  const twoByteOver = fixture()
  twoByteOver.file.name = 'é'.repeat(128) // 256 bytes, only 128 UTF-16 units
  expect(() => parseRecordingManifest(JSON.stringify(twoByteOver))).toThrow('invalid')
})

it('measures marker label bounds in UTF-8 bytes (256)', () => {
  const atLimit = fixture()
  atLimit.markers = [marker({ label: '😀'.repeat(64) })] // 256 bytes
  expect(parseRecordingManifest(JSON.stringify(atLimit)).markers[0].label).toBe('😀'.repeat(64))

  const overLimit = fixture()
  overLimit.markers = [marker({ label: `${'😀'.repeat(64)}a` })]
  expect(() => parseRecordingManifest(JSON.stringify(overLimit))).toThrow('invalid')

  const twoByteOver = fixture()
  twoByteOver.markers = [marker({ label: 'é'.repeat(129) })] // 258 bytes, 129 units
  expect(() => parseRecordingManifest(JSON.stringify(twoByteOver))).toThrow('invalid')
})

it('keeps the 64 KiB payload cap on UTF-8 bytes', () => {
  const base = JSON.stringify(fixture())
  const padTo = (bytes: number, unit: string) => {
    const unitBytes = Buffer.byteLength(unit, 'utf8')
    const room = bytes - Buffer.byteLength(base, 'utf8') - Buffer.byteLength(',"x":""', 'utf8')
    return base.slice(0, -1) + `,"x":"${unit.repeat(Math.floor(room / unitBytes))}"}`
  }
  const overByBytes = padTo(65536 + 8, '😀')
  expect(overByBytes.length).toBeLessThan(65536) // under the cap in UTF-16 units, over it in bytes
  expect(Buffer.byteLength(overByBytes, 'utf8')).toBeGreaterThan(65536)
  expect(() => parseRecordingManifest(overByBytes)).toThrow('64 KiB')
})

const measured = () => ({
  sha256: sha, byteLength: 64044,
  layout: {
    container: 'wav' as const, codec: 'pcm_s16le', channels: 2, sampleRate: 16000,
    durationSeconds: 1, durationSource: 'decoded-frames' as const, originalSha256: sha
  }
})
const proofFor = (clock: object, source = 'pcm-frame-measurement' as const) =>
  ({ originalSha256: sha, evidenceId: 'proof-1', source, clock: clock as any })

it('parses a 48 kHz capture clock over 16 kHz audio but refuses association even when the proof copies the claim', () => {
  const input = fixture()
  input.audio.clock = { sampleRateHz: 48000, frameCount: 48000, encoderDelayFrames: 0, encoderPaddingFrames: 0 }
  const parsed = parseRecordingManifest(JSON.stringify(input))
  expect(parsed.audio.sampleRateHz).toBe(16000)
  expect(parsed.audio.clock?.sampleRateHz).toBe(48000)

  const copied = proofFor({ ...input.audio.clock })
  expect(() => assertRecordingManifestBinding(parsed, { ...measured(), clockEvidence: copied })).toThrow('capture clock rate differs')
  expect(() => assertRecordingManifestBinding(parsed, measured())).toThrow('capture clock rate differs')
})

it('refuses a rate mismatch whatever frame count the proof carries, with no ratio deduced', () => {
  const input = fixture()
  input.audio.clock = { sampleRateHz: 48000, frameCount: 48000, encoderDelayFrames: 0, encoderPaddingFrames: 0 }
  const parsed = parseRecordingManifest(JSON.stringify(input))
  const converted = proofFor({ sampleRateHz: 16000, frameCount: 16000, encoderDelayFrames: 0, encoderPaddingFrames: 0 })
  expect(() => assertRecordingManifestBinding(parsed, { ...measured(), clockEvidence: converted })).toThrow('capture clock rate differs')
})

it('still binds a null clock and a matching-rate clock with its independent proof', () => {
  expect(() => assertRecordingManifestBinding(parseRecordingManifest(JSON.stringify(fixture())), measured())).not.toThrow()

  const input = fixture()
  input.audio.clock = { sampleRateHz: 16000, frameCount: 16000, encoderDelayFrames: 0, encoderPaddingFrames: 0 }
  const parsed = parseRecordingManifest(JSON.stringify(input))
  expect(() => assertRecordingManifestBinding(parsed, { ...measured(), clockEvidence: proofFor({ ...input.audio.clock }) })).not.toThrow()
  expect(() => assertRecordingManifestBinding(parsed, measured())).toThrow('independent')
})

it('keeps a null-ID marker with a known manual or automatic type parseable and bindable', () => {
  for (const type of ['manual', 'automatic']) {
    const input = fixture()
    input.markers = [{ markerId: null, type, position: { unit: 'legacy-ms', value: 1 } }]
    const parsed = parseRecordingManifest(JSON.stringify(input))
    expect(parsed.markers[0]).toMatchObject({ markerId: null, type })
    expect(() => assertRecordingManifestBinding(parsed, measured())).not.toThrow()
  }
})

it('still accepts a legacy marker with a null identity and type unknown', () => {
  const input = fixture()
  input.markers = [{ markerId: null, type: 'unknown', position: { unit: 'legacy-ms', value: 1 } }]
  expect(parseRecordingManifest(JSON.stringify(input)).markers[0].markerId).toBeNull()
})
