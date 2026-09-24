/**
 * Voice recognition engines: which one produces the per-recording speaker
 * segments and voice embeddings that `persistMatches` turns into stable voice
 * IDs across recordings.
 *
 * Spec: docs/superpowers/specs/2026-09-24-speaker-engines-design.md
 *
 * Every engine returns the same AcousticWorkerResult, so everything after it
 * (matching, relabelling, contact anchoring) is shared. Engines not built yet
 * stay in this catalogue for the plan, but the Speaker setup never shows them
 * and a config naming one falls back to automatic.
 */

export type SpeakerEngineId =
  | 'auto'
  | 'pyannote-local'
  | 'onnx-local'
  | 'signatures-from-turns'
  | 'model-host'
  | 'pyannoteai'
  | 'off'

export interface SpeakerEngineDescriptor {
  id: SpeakerEngineId
  label: string
  /** One sentence the owner can decide on. */
  description: string
  where: 'this computer' | 'your network' | 'online' | 'nowhere'
  /** False until the phase that builds it ships. */
  built: boolean
}

export const SPEAKER_ENGINES: Record<Exclude<SpeakerEngineId, 'auto'>, SpeakerEngineDescriptor> = {
  'pyannote-local': {
    id: 'pyannote-local',
    label: 'pyannote on this computer',
    description:
      'Separates speakers and learns their voices here. Fast with an NVIDIA GPU; on a CPU it takes about a third of the recording length.',
    where: 'this computer',
    built: true,
  },
  'onnx-local': {
    id: 'onnx-local',
    label: 'ONNX on this computer (AMD, Intel or CPU)',
    description:
      'The same voice model through ONNX Runtime: runs on AMD and Intel GPUs with DirectML, and faster than pyannote on a CPU.',
    where: 'this computer',
    built: false,
  },
  'signatures-from-turns': {
    id: 'signatures-from-turns',
    label: 'Voice signatures from the transcript',
    description:
      'Uses the speaker turns the transcriber already returns and learns each voice from a few seconds of it. Seconds per recording on any computer.',
    where: 'this computer',
    built: false,
  },
  'model-host': {
    id: 'model-host',
    label: 'HiDock Model Host on your network',
    description:
      'Sends the audio to your own GPU machine on the local network and falls back to this computer if it is off or busy.',
    where: 'your network',
    built: true,
  },
  pyannoteai: {
    id: 'pyannoteai',
    label: 'pyannoteAI (online)',
    description:
      'Speaker separation and reusable voiceprints from pyannoteAI. Costs about €0.10 per hour of audio and needs an API key.',
    where: 'online',
    built: false,
  },
  off: {
    id: 'off',
    label: 'Turn voice recognition off',
    description:
      'Speakers stay "Speaker 1, Speaker 2" and known people are no longer named automatically.',
    where: 'nowhere',
    built: true,
  },
}

/**
 * The model the voice library is built with, and the default when the library
 * is empty. Every existing voice ID lives in its space; another model joins
 * only through a model transfer (spec: "Canonical voice IDs and model transfer").
 */
export const CANONICAL_VOICE_MODEL = 'pyannote/speaker-diarization-3.1'

export interface SpeakerEngineConfig {
  speakerEngine?: SpeakerEngineId | string
  speakerLinkingEnabled?: boolean
  modelHostUrl?: string
}

/**
 * The engine that actually runs. `auto` (and any engine not built yet) keeps
 * today's behaviour: the Model Host when one is configured, else this
 * computer. The old `speakerLinkingEnabled` switch was the privacy control and
 * still is, for every engine: anything but true means off. The setup keeps the
 * two fields in step, so this only matters for a hand-edited config.
 */
export function resolveSpeakerEngine(config: SpeakerEngineConfig): Exclude<SpeakerEngineId, 'auto'> {
  if (config.speakerLinkingEnabled !== true) return 'off'
  const chosen = config.speakerEngine
  if (chosen && chosen !== 'auto' && chosen in SPEAKER_ENGINES) {
    const engine = SPEAKER_ENGINES[chosen as Exclude<SpeakerEngineId, 'auto'>]
    if (engine.built) return engine.id as Exclude<SpeakerEngineId, 'auto'>
  }
  return config.modelHostUrl?.trim() ? 'model-host' : 'pyannote-local'
}
