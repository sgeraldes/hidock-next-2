/**
 * Developer > Advanced: config values that exist but had no control
 * (settings map, 28-sep-2026). Each one is a single key in config.json; the
 * default shown next to it comes from the main process, never from here.
 */

export type AdvancedSection = 'embeddings' | 'transcription' | 'chat' | 'quality'

export interface AdvancedSetting {
  section: AdvancedSection
  key: string
  /** The heading the row sits under; each list names its groups in order. */
  group: string
  label: string
  detail: string
  kind: 'number' | 'text'
  min?: number
  max?: number
  step?: number
  unit?: string
  /** A text value that may be left empty (empty means "find it"). */
  allowEmpty?: boolean
  /** Only whole numbers (the main process rounds these). */
  integer?: boolean
}

export const ADVANCED_SETTINGS: AdvancedSetting[] = [
  {
    section: 'embeddings', key: 'chunkSize', group: 'Search', kind: 'number', integer: true, min: 100, max: 4000, step: 50, unit: 'characters',
    label: 'Passage size',
    detail: 'How much text each search passage holds. Applies to text indexed from now on.'
  },
  {
    section: 'embeddings', key: 'chunkOverlap', group: 'Search', kind: 'number', integer: true, min: 0, max: 1000, step: 10, unit: 'characters',
    label: 'Passage overlap',
    detail: 'Text repeated between neighbouring passages, so a sentence is not cut in two. At most half the passage size.'
  },
  {
    section: 'chat', key: 'geminiModel', group: 'AI models', kind: 'text',
    label: 'Gemini model for chat and analysis',
    detail: 'Also describes images. The transcription model is chosen on Transcription > Gemini.'
  },
  {
    section: 'transcription', key: 'vibevoiceModelId', group: 'AI models', kind: 'text',
    label: 'VibeVoice model',
    detail: 'The Hugging Face model the VibeVoice engine loads.'
  },
  {
    section: 'transcription', key: 'vibevoiceDevice', group: 'AI models', kind: 'text',
    label: 'VibeVoice device',
    detail: 'Where VibeVoice runs: cuda:0 for the first NVIDIA GPU, cpu otherwise. This PC has an AMD GPU, so cuda does not apply here.'
  },
  {
    section: 'transcription', key: 'valueClassificationMinConfidence', group: 'Ratings', kind: 'number', min: 0, max: 1, step: 0.05,
    label: 'Rating confidence floor',
    detail: 'A rating below this confidence is not applied; the recording stays unrated.'
  },
  {
    section: 'transcription', key: 'speakerLinkingMatchThreshold', group: 'Voice matching', kind: 'number', min: 0.5, max: 0.99, step: 0.01,
    label: 'Voice match threshold',
    detail: 'How similar a voice must be to a known one to be named after it. Higher names fewer, with fewer mistakes.'
  },
  {
    section: 'transcription', key: 'speakerLinkingMatchMargin', group: 'Voice matching', kind: 'number', min: 0, max: 0.5, step: 0.01,
    label: 'Voice match margin',
    detail: 'How far ahead of the second-best voice the best one must be.'
  },
  {
    section: 'transcription', key: 'speakerLinkingMinSpeechSeconds', group: 'Voice matching', kind: 'number', min: 1, max: 60, step: 1, unit: 's',
    label: 'Speech needed per voice',
    detail: 'A voice with less speech than this in a recording is not matched.'
  },
  {
    section: 'transcription', key: 'speakerLinkingTimeoutSeconds', group: 'Voice matching', kind: 'number', integer: true, min: 60, max: 21600, step: 60, unit: 's',
    label: 'Voice step time limit',
    detail: 'The least time the voice step gets; long recordings get 1.5 times their length.'
  },
  {
    section: 'transcription', key: 'speakerLinkingPythonPath', group: 'Voice matching', kind: 'text',
    label: 'Python for the voice step',
    detail: 'The Python that runs the pyannote voice step.'
  },
  {
    section: 'transcription', key: 'speakerLinkingWorkerPath', group: 'Voice matching', kind: 'text', allowEmpty: true,
    label: 'Voice worker script',
    detail: 'Leave empty to use the one that ships with HiDock.'
  }
]

export const ADVANCED_GROUPS: string[] = ['Search', 'Ratings', 'Voice matching', 'AI models']

/** Read a typed value, or say what is wrong with it. `others` is the section's current values. */
export function parseAdvancedValue(
  setting: AdvancedSetting,
  raw: string,
  others: Record<string, unknown> = {}
): { value: number | string } | { error: string } {
  const text = raw.trim()
  if (setting.kind === 'text') {
    if (!text && !setting.allowEmpty) return { error: 'Cannot be empty' }
    return { value: text }
  }
  const value = Number(text.replace(',', '.'))
  if (!text || !Number.isFinite(value)) return { error: 'Enter a number' }
  if (setting.integer && !Number.isInteger(value)) return { error: 'Enter a whole number' }
  if (setting.min !== undefined && value < setting.min) return { error: `At least ${setting.min}` }
  if (setting.max !== undefined && value > setting.max) return { error: `At most ${setting.max}` }
  // The main process caps the overlap at half the passage size (rag-settings.ts).
  if (setting.key === 'chunkOverlap' && typeof others.chunkSize === 'number' && value > Math.floor(others.chunkSize / 2)) {
    return { error: `At most half the passage size (${Math.floor(others.chunkSize / 2)}). Raise the passage size first.` }
  }
  if (setting.key === 'chunkSize' && typeof others.chunkOverlap === 'number' && value < others.chunkOverlap * 2) {
    return { error: `At least twice the overlap (${others.chunkOverlap * 2}). Lower the overlap first.` }
  }
  return { value }
}
