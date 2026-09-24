/**
 * Renderer view of the Speaker setup (see electron/main/services/speaker-setup.ts).
 * Spec: docs/superpowers/specs/2026-09-24-speaker-engines-design.md
 */

export type SpeakerEngineId =
  | 'auto'
  | 'pyannote-local'
  | 'onnx-local'
  | 'signatures-from-turns'
  | 'model-host'
  | 'pyannoteai'
  | 'off'

export type HardwareProfile = 'nvidia-cuda' | 'gpu-directml' | 'cpu-with-host' | 'cpu-only'

export interface DetectedGpu {
  name: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'other'
  driver: string | null
  cuda: boolean
}

export interface SpeakerSetupOption {
  engine: Exclude<SpeakerEngineId, 'auto'>
  label: string
  description: string
  where: string
  available: boolean
  unavailableReason?: string
  recommended: boolean
  idealForHardware: boolean
  measuredSpeedRatio?: number
}

export interface SpeakerSetup {
  hardware: { gpus: DetectedGpu[]; cpu: { model: string; logicalCores: number }; platform: string }
  fingerprint: string
  profile: HardwareProfile
  profileSummary: string
  options: SpeakerSetupOption[]
  configuredEngine: SpeakerEngineId
  effectiveEngine: Exclude<SpeakerEngineId, 'auto'>
  needsConfirmation: boolean
  lastConfirmedAt: string | null
  voiceSpace: { model: string; modelVersion: string | null; clusters: number; anchored: number } | null
}
