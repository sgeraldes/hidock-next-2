/**
 * What hardware this computer has for voice recognition, and which engines to
 * offer on it.
 *
 * Spec: docs/superpowers/specs/2026-09-24-speaker-engines-design.md
 *
 * The fingerprint is the sorted list of real GPUs (virtual displays excluded).
 * The Speaker setup opens only when it changes: a GPU added or removed. It is
 * not tied to driver versions, so a driver update does not ask again.
 */

import { execFile } from 'child_process'
import { cpus } from 'os'
import { SPEAKER_ENGINES, type SpeakerEngineId } from './speaker-engines'

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other'

export interface DetectedGpu {
  name: string
  vendor: GpuVendor
  driver: string | null
  /** True when nvidia-smi answers for it: CUDA works. */
  cuda: boolean
}

export interface DetectedHardware {
  gpus: DetectedGpu[]
  cpu: { model: string; logicalCores: number }
  platform: NodeJS.Platform
  /**
   * True when the GPU query itself failed (PowerShell missing, WMI error,
   * timeout), as opposed to answering with no GPUs. An empty list then says
   * nothing about the machine, and the setup must not ask on it.
   */
  detectionFailed?: boolean
}

export type HardwareProfile = 'nvidia-cuda' | 'gpu-directml' | 'cpu-with-host' | 'cpu-only'

/** stdout, or null when the command could not run or failed. */
type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string | null>

const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : String(stdout))
    )
  })

/** Display adapters that are not a GPU: remote, virtual and the basic fallback driver. */
const NOT_A_GPU = /virtual|basic display|basic render|remote display|indirect display|parsec|spacedesk|meta quest|mirage/i

export function vendorOf(name: string, company = ''): GpuVendor {
  const s = `${name} ${company}`
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(s)) return 'nvidia'
  if (/amd|radeon|advanced micro devices|ati /i.test(s)) return 'amd'
  if (/intel|arc\b|iris|uhd graphics/i.test(s)) return 'intel'
  return 'other'
}

interface WmiAdapter {
  Name?: string
  DriverVersion?: string
  AdapterCompatibility?: string
}

/** null when the output is not the JSON the query produces: the query failed. */
export function parseWmiAdapters(json: string | null): Omit<DetectedGpu, 'cuda'>[] | null {
  if (json === null) return null
  // No video controller at all prints nothing.
  if (!json.trim()) return []
  let rows: WmiAdapter[] = []
  try {
    const parsed = JSON.parse(json) as WmiAdapter | WmiAdapter[]
    rows = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return null
  }
  return rows
    .filter((r) => r?.Name && !NOT_A_GPU.test(r.Name))
    .map((r) => ({ name: r.Name!.trim(), vendor: vendorOf(r.Name!, r.AdapterCompatibility), driver: r.DriverVersion ?? null }))
}

/** Names of the GPUs nvidia-smi can drive (CUDA works for these). */
export function parseNvidiaSmi(csv: string | null): string[] {
  return (csv ?? '')
    .split(/\r?\n/)
    .map((l) => l.split(',')[0]?.trim())
    .filter((n): n is string => !!n)
}

export async function detectHardware(exec: Exec = defaultExec): Promise<DetectedHardware> {
  const cpuList = cpus()
  const cpu = { model: cpuList[0]?.model?.trim() ?? 'unknown', logicalCores: cpuList.length }
  if (process.platform !== 'win32') {
    // Only Windows is shipped today. Elsewhere, report no GPU rather than guess.
    return { gpus: [], cpu, platform: process.platform }
  }
  const [wmi, smi] = await Promise.all([
    exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterCompatibility | ConvertTo-Json -Compress',
      ],
      8000
    ),
    exec('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], 5000),
  ])
  const cudaNames = parseNvidiaSmi(smi)
  const adapters = parseWmiAdapters(wmi)
  if (adapters === null) {
    console.warn('[HardwareProfile] The GPU query failed; not treating this as a machine without a GPU.')
    return { gpus: [], cpu, platform: process.platform, detectionFailed: true }
  }
  const gpus = adapters.map((g) => ({
    ...g,
    cuda: g.vendor === 'nvidia' && cudaNames.some((n) => g.name.includes(n) || n.includes(g.name)),
  }))
  return { gpus, cpu, platform: process.platform }
}

/** Stable across launches and driver updates; changes when a GPU is added or removed. */
export function gpuFingerprint(hardware: DetectedHardware): string {
  const names = hardware.gpus.map((g) => `${g.vendor}:${g.name}`).sort()
  return names.length ? names.join('|') : 'no-gpu'
}

export function profileOf(hardware: DetectedHardware, modelHostPaired: boolean): HardwareProfile {
  if (hardware.gpus.some((g) => g.cuda)) return 'nvidia-cuda'
  if (modelHostPaired) return 'cpu-with-host'
  if (hardware.gpus.some((g) => g.vendor === 'amd' || g.vendor === 'intel' || g.vendor === 'nvidia')) {
    return 'gpu-directml'
  }
  return 'cpu-only'
}

/** Best first, per the spec's table. `off` is always last and never recommended. */
const ORDER: Record<HardwareProfile, Exclude<SpeakerEngineId, 'auto'>[]> = {
  'nvidia-cuda': ['pyannote-local', 'onnx-local', 'signatures-from-turns', 'model-host', 'pyannoteai', 'off'],
  'gpu-directml': ['onnx-local', 'signatures-from-turns', 'model-host', 'pyannoteai', 'pyannote-local', 'off'],
  'cpu-with-host': ['model-host', 'signatures-from-turns', 'onnx-local', 'pyannoteai', 'pyannote-local', 'off'],
  'cpu-only': ['signatures-from-turns', 'onnx-local', 'pyannoteai', 'model-host', 'pyannote-local', 'off'],
}

export interface SpeakerSetupOption {
  engine: Exclude<SpeakerEngineId, 'auto'>
  label: string
  description: string
  where: string
  /** Can be chosen today. */
  available: boolean
  /** Why it cannot be chosen, when it cannot. */
  unavailableReason?: string
  /** The best choice for this hardware among the available ones. */
  recommended: boolean
  /** The best choice for this hardware, even if it is not built yet. */
  idealForHardware: boolean
  /** Processing time as a share of the audio length, when it was measured on this computer. */
  measuredSpeedRatio?: number
}

export interface SpeakerSetupInput {
  hardware: DetectedHardware
  modelHostPaired: boolean
  /** pyannote-local's measured time per second of audio on this computer's device. */
  measuredLocalRatio?: number | null
}

export function buildSetupOptions({ hardware, modelHostPaired, measuredLocalRatio }: SpeakerSetupInput): {
  profile: HardwareProfile
  options: SpeakerSetupOption[]
} {
  const profile = profileOf(hardware, modelHostPaired)
  const order = ORDER[profile]
  const options: SpeakerSetupOption[] = order.map((engine, index) => {
    const d = SPEAKER_ENGINES[engine]
    let available = d.built
    let unavailableReason = d.built ? undefined : 'Not built yet; it arrives in a later update.'
    if (engine === 'model-host' && d.built && !modelHostPaired) {
      available = false
      unavailableReason = 'No Model Host is paired. Pair one in Settings first.'
    }
    return {
      engine,
      label: d.label,
      description: d.description,
      where: d.where,
      available,
      unavailableReason,
      recommended: false,
      idealForHardware: index === 0,
      measuredSpeedRatio: engine === 'pyannote-local' && measuredLocalRatio ? measuredLocalRatio : undefined,
    }
  })
  const recommended = options.find((o) => o.available && o.engine !== 'off')
  if (recommended) recommended.recommended = true
  return { profile, options }
}

export function describeProfile(profile: HardwareProfile, hardware: DetectedHardware): string {
  if (hardware.detectionFailed) {
    return 'Could not read the GPUs on this computer. Press "Detect again" to retry.'
  }
  const gpuNames = hardware.gpus.map((g) => g.name).join(', ')
  switch (profile) {
    case 'nvidia-cuda':
      return `NVIDIA GPU with CUDA (${gpuNames}).`
    case 'gpu-directml':
      return `GPU without CUDA (${gpuNames}). pyannote can only use the CPU here.`
    case 'cpu-with-host':
      return `No CUDA GPU here${gpuNames ? ` (${gpuNames})` : ''}, and a Model Host is paired on your network.`
    case 'cpu-only':
      return 'No usable GPU: voice recognition runs on the CPU unless another option is chosen.'
  }
}
