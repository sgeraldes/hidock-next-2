/**
 * The Speaker setup: detect the hardware, offer the engines for it with one
 * recommended, and ask again only when a GPU is added or removed.
 *
 * Spec: docs/superpowers/specs/2026-09-24-speaker-engines-design.md
 */

import { getConfig, updateConfig } from './config'
import { queryAll } from './database'
import {
  buildSetupOptions,
  describeProfile,
  detectHardware,
  gpuFingerprint,
  type DetectedHardware,
  type HardwareProfile,
  type SpeakerSetupOption,
} from './hardware-profile'
import { resolveSpeakerEngine, SPEAKER_ENGINES, type SpeakerEngineId } from './speaker-engines'
import { libraryVoiceSpace, type LibraryVoiceSpace } from './speaker-linking'

export interface SpeakerSetup {
  hardware: DetectedHardware
  fingerprint: string
  profile: HardwareProfile
  profileSummary: string
  options: SpeakerSetupOption[]
  /** What the config says, and what actually runs after resolving 'auto'. */
  configuredEngine: SpeakerEngineId
  effectiveEngine: Exclude<SpeakerEngineId, 'auto'>
  /** True when the GPUs differ from the last confirmed setup, or none was ever confirmed. */
  needsConfirmation: boolean
  lastConfirmedAt: string | null
  voiceSpace: LibraryVoiceSpace | null
}

let cached: Promise<DetectedHardware> | null = null

/** Detection runs once per app session unless asked to refresh (Settings). */
function hardware(refresh = false): Promise<DetectedHardware> {
  if (!cached || refresh) cached = detectHardware()
  return cached
}

/**
 * Local pyannote's measured seconds of processing per second of audio, on the
 * device this computer uses now (cuda or cpu), from the last completed runs.
 */
export function measuredLocalSpeedRatio(device: 'cuda' | 'cpu'): number | null {
  const rows = queryAll<{ started_at: string; completed_at: string; duration_seconds: number; quality_json: string | null }>(
    `SELECT p.started_at, p.completed_at, r.duration_seconds, p.quality_json
       FROM processing_runs p JOIN recordings r ON r.id = p.recording_id
      WHERE p.stage = 'diarization' AND p.provider = 'pyannote' AND p.execution = 'local'
        AND p.status IN ('completed', 'degraded') AND p.completed_at IS NOT NULL
        AND r.duration_seconds >= 300
      ORDER BY p.started_at DESC LIMIT 60`
  )
  const ratios: number[] = []
  for (const row of rows) {
    let runDevice: string | null = null
    try {
      runDevice = row.quality_json ? (JSON.parse(row.quality_json) as { device?: string }).device ?? null : null
    } catch {
      runDevice = null
    }
    if (runDevice !== device) continue
    const seconds = (Date.parse(row.completed_at) - Date.parse(row.started_at)) / 1000
    if (seconds > 0 && row.duration_seconds > 0) ratios.push(seconds / row.duration_seconds)
    if (ratios.length >= 20) break
  }
  if (ratios.length < 3) return null
  ratios.sort((a, b) => a - b)
  return ratios[Math.floor(ratios.length / 2)]
}

export async function getSpeakerSetup(options: { refresh?: boolean } = {}): Promise<SpeakerSetup> {
  const config = getConfig().transcription
  const detected = await hardware(options.refresh)
  const fingerprint = gpuFingerprint(detected)
  const modelHostPaired = !!config.modelHostUrl?.trim() && !!config.modelHostToken
  const device = detected.gpus.some((g) => g.cuda) ? 'cuda' : 'cpu'
  const { profile, options: engineOptions } = buildSetupOptions({
    hardware: detected,
    modelHostPaired,
    measuredLocalRatio: measuredLocalSpeedRatio(device),
  })
  return {
    hardware: detected,
    fingerprint,
    profile,
    profileSummary: describeProfile(profile, detected),
    options: engineOptions,
    configuredEngine: (config.speakerEngine as SpeakerEngineId) || 'auto',
    effectiveEngine: resolveSpeakerEngine(config),
    needsConfirmation: config.speakerSetupFingerprint !== fingerprint,
    lastConfirmedAt: config.speakerSetupAt || null,
    voiceSpace: libraryVoiceSpace(),
  }
}

export class SpeakerSetupError extends Error {}

/** Tests only: forget the detection cached for this session. */
export function resetSpeakerSetupCache(): void {
  cached = null
}

/**
 * Save the owner's choice for this hardware. Turning voice recognition off
 * requires `confirmOff`, the second confirmation behind the red warning.
 */
export async function applySpeakerSetup(choice: {
  engine: SpeakerEngineId
  fingerprint: string
  confirmOff?: boolean
}): Promise<SpeakerSetup> {
  if (choice.engine !== 'auto') {
    const descriptor = SPEAKER_ENGINES[choice.engine]
    if (!descriptor) throw new SpeakerSetupError(`Unknown engine: ${choice.engine}`)
    if (!descriptor.built) throw new SpeakerSetupError(`${descriptor.label} is not available yet.`)
  }
  if (choice.engine === 'off' && choice.confirmOff !== true) {
    throw new SpeakerSetupError('Turning voice recognition off needs an explicit confirmation.')
  }
  if (choice.engine === 'model-host') {
    const config = getConfig().transcription
    if (!config.modelHostUrl?.trim() || !config.modelHostToken) {
      throw new SpeakerSetupError('Pair a Model Host before choosing it.')
    }
  }
  // The hardware this process detected, not the one the window showed: a GPU
  // removed while the dialog was open must still ask again next launch.
  const fingerprint = gpuFingerprint(await hardware())
  if (fingerprint !== choice.fingerprint) {
    console.warn(`[SpeakerSetup] the hardware changed while the setup was open (${choice.fingerprint} -> ${fingerprint})`)
  }
  await updateConfig('transcription', {
    speakerEngine: choice.engine,
    // Kept in step for anything that still reads the old switch.
    speakerLinkingEnabled: choice.engine !== 'off',
    speakerSetupFingerprint: fingerprint,
    speakerSetupAt: new Date().toISOString(),
  })
  return getSpeakerSetup()
}
