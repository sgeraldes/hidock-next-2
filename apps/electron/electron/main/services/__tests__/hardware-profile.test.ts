/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  buildSetupOptions,
  detectHardware,
  gpuFingerprint,
  parseNvidiaSmi,
  parseWmiAdapters,
  profileOf,
  vendorOf,
  type DetectedHardware,
} from '../hardware-profile'
import { resolveSpeakerEngine } from '../speaker-engines'

// What this owner's PC reports on 24-sep-2026.
const OWNER_WMI = JSON.stringify([
  { Name: 'USB Mobile Monitor Virtual Display', DriverVersion: '2.0.0.1', AdapterCompatibility: 'Virtual' },
  { Name: 'AMD Radeon(TM) Graphics', DriverVersion: '32.0.21045.5002', AdapterCompatibility: 'Advanced Micro Devices, Inc.' },
  { Name: 'AMD Radeon RX 6600 XT', DriverVersion: '32.0.21045.5002', AdapterCompatibility: 'Advanced Micro Devices, Inc.' },
])

const cpu = { model: 'AMD Ryzen 9 7900X3D 12-Core Processor', logicalCores: 24 }
const ownerGpus = () => parseWmiAdapters(OWNER_WMI)!
const hw = (gpus: DetectedHardware['gpus']): DetectedHardware => ({ gpus, cpu, platform: 'win32' })

describe('GPU detection', () => {
  it('reads the real GPUs and drops virtual displays', () => {
    const gpus = ownerGpus()
    expect(gpus.map((g) => g.name)).toEqual(['AMD Radeon(TM) Graphics', 'AMD Radeon RX 6600 XT'])
    expect(gpus.every((g) => g.vendor === 'amd')).toBe(true)
  })

  it('accepts a single adapter object and survives bad output', () => {
    expect(parseWmiAdapters(JSON.stringify({ Name: 'NVIDIA GeForce RTX 4090', DriverVersion: '1' }))).toHaveLength(1)
    expect(parseWmiAdapters('')).toEqual([])
  })

  it('tells a failed query apart from a machine with no GPU', async () => {
    expect(parseWmiAdapters(null)).toBeNull()
    expect(parseWmiAdapters('not json')).toBeNull()
    if (process.platform !== 'win32') return
    const failed = await detectHardware(async (file) => (file === 'nvidia-smi' ? null : null))
    expect(failed.detectionFailed).toBe(true)
    const none = await detectHardware(async (file) => (file === 'nvidia-smi' ? null : ''))
    expect(none.detectionFailed).toBeUndefined()
    expect(gpuFingerprint(none)).toBe('no-gpu')
  })

  it('names vendors', () => {
    expect(vendorOf('NVIDIA GeForce RTX 4090')).toBe('nvidia')
    expect(vendorOf('Intel(R) Arc(TM) A770')).toBe('intel')
    expect(vendorOf('Something', 'Advanced Micro Devices, Inc.')).toBe('amd')
  })

  it('marks CUDA only for GPUs nvidia-smi can drive', async () => {
    const exec = async (file: string) =>
      file === 'nvidia-smi'
        ? 'NVIDIA GeForce RTX 4090\n'
        : JSON.stringify([{ Name: 'NVIDIA GeForce RTX 4090' }, { Name: 'AMD Radeon(TM) Graphics' }])
    if (process.platform !== 'win32') return
    const detected = await detectHardware(exec)
    expect(detected.gpus.find((g) => g.vendor === 'nvidia')?.cuda).toBe(true)
    expect(detected.gpus.find((g) => g.vendor === 'amd')?.cuda).toBe(false)
    expect(parseNvidiaSmi('A, 1\r\nB, 2\r\n')).toEqual(['A', 'B'])
  })
})

describe('fingerprint', () => {
  it('changes when a GPU is added or removed, not when a driver updates', () => {
    const base = hw(ownerGpus().map((g) => ({ ...g, cuda: false })))
    const newDriver = hw(base.gpus.map((g) => ({ ...g, driver: '99.0' })))
    const with4090 = hw([...base.gpus, { name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', driver: '1', cuda: true }])
    expect(gpuFingerprint(newDriver)).toBe(gpuFingerprint(base))
    expect(gpuFingerprint(with4090)).not.toBe(gpuFingerprint(base))
    expect(gpuFingerprint(hw([]))).toBe('no-gpu')
  })

  it('does not depend on the order WMI lists the adapters', () => {
    const gpus = ownerGpus().map((g) => ({ ...g, cuda: false }))
    expect(gpuFingerprint(hw([...gpus].reverse()))).toBe(gpuFingerprint(hw(gpus)))
  })
})

describe('profiles and recommendations', () => {
  const amd = hw(ownerGpus().map((g) => ({ ...g, cuda: false })))
  const nvidia = hw([{ name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', driver: '1', cuda: true }])

  it('classifies the owner PC as a GPU without CUDA', () => {
    expect(profileOf(amd, false)).toBe('gpu-directml')
    expect(profileOf(amd, true)).toBe('cpu-with-host')
    expect(profileOf(nvidia, false)).toBe('nvidia-cuda')
    expect(profileOf(hw([]), false)).toBe('cpu-only')
  })

  it('offers only engines that are built, and recommends the best of them', () => {
    const { options } = buildSetupOptions({ hardware: amd, modelHostPaired: false, measuredLocalRatio: 0.33 })
    // Not built yet: never listed, not even greyed out.
    expect(options.map((o) => o.engine)).toEqual(['onnx-local', 'model-host', 'pyannote-local', 'off'])
    for (const hardware of [amd, nvidia, hw([])]) {
      for (const o of buildSetupOptions({ hardware, modelHostPaired: false }).options) {
        expect(['onnx-local', 'pyannote-local', 'model-host', 'off']).toContain(o.engine)
      }
    }
    const recommended = options.filter((o) => o.recommended)
    expect(recommended).toHaveLength(1)
    // On a GPU without CUDA the ONNX engine runs the same voice model through DirectML.
    expect(recommended[0].engine).toBe('onnx-local')
    expect(options.find((o) => o.engine === 'model-host')?.unavailableReason).toMatch(/Pair/)
    expect(options.find((o) => o.engine === 'pyannote-local')?.measuredSpeedRatio).toBe(0.33)
  })

  it('recommends the paired Model Host on a machine without CUDA', () => {
    const { options } = buildSetupOptions({ hardware: amd, modelHostPaired: true })
    expect(options.find((o) => o.recommended)?.engine).toBe('model-host')
  })

  it('never recommends turning voice recognition off, and always offers it last', () => {
    for (const hardware of [amd, nvidia, hw([])]) {
      const { options } = buildSetupOptions({ hardware, modelHostPaired: false })
      expect(options.at(-1)?.engine).toBe('off')
      expect(options.find((o) => o.engine === 'off')?.recommended).toBe(false)
    }
  })
})

describe('resolveSpeakerEngine', () => {
  it('keeps the behaviour from before the setup for existing installs', () => {
    const on = { speakerLinkingEnabled: true }
    expect(resolveSpeakerEngine({ ...on, speakerEngine: 'auto' })).toBe('pyannote-local')
    expect(resolveSpeakerEngine({ ...on, speakerEngine: 'auto', modelHostUrl: 'http://gamestation:8765' })).toBe('model-host')
    expect(resolveSpeakerEngine({ speakerLinkingEnabled: false })).toBe('off')
    expect(resolveSpeakerEngine({})).toBe('off')
  })

  it('honours an explicit choice, and never runs an engine that is not built', () => {
    const on = { speakerLinkingEnabled: true }
    expect(resolveSpeakerEngine({ ...on, speakerEngine: 'pyannote-local', modelHostUrl: 'http://x' })).toBe('pyannote-local')
    expect(resolveSpeakerEngine({ ...on, speakerEngine: 'off' })).toBe('off')
    expect(resolveSpeakerEngine({ ...on, speakerEngine: 'onnx-local' })).toBe('onnx-local')
    expect(resolveSpeakerEngine({ ...on, speakerEngine: 'pyannoteai' })).toBe('pyannote-local')
    expect(resolveSpeakerEngine({ ...on, speakerEngine: 'nonsense' })).toBe('pyannote-local')
  })

  it('treats the old off switch as off for any engine (a hand-edited config)', () => {
    expect(resolveSpeakerEngine({ speakerEngine: 'pyannote-local', speakerLinkingEnabled: false })).toBe('off')
    expect(resolveSpeakerEngine({ speakerEngine: 'model-host', modelHostUrl: 'http://x' })).toBe('off')
  })
})
