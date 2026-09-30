/**
 * Descriptors of the harnesses that are not brains: the audio engines transcription.ts and
 * speaker-linking.ts drive, and Jev. They are constants, not classes: nothing calls them through
 * the BrainRouter (audio stays outside it, and Jev answers questions, it does not write text).
 * They exist so the Pipeline page can offer them, and refuse an impossible pair, in the same
 * words as the brains.
 *
 * Sources (inventory 2026-09-30): rows 1 to 7 and 13 to 15. The model of each engine is chosen in
 * its own settings today (transcription.provider, transcription.speakerEngine); the choice moves
 * to the Pipeline page in phase 4 of the pipeline design.
 */
import { caps, type HarnessDescriptor } from './descriptor'

export const ENGINE_DESCRIPTORS: readonly HarnessDescriptor[] = [
  {
    id: 'gemini-transcribe',
    label: 'Gemini transcription',
    kind: 'engine',
    vendor: 'Google',
    dataLeavesMachine: true,
    latency: 'heavy',
    capabilities: caps('audio', 'timestamps', 'diarization', 'long-context'),
    effort: { kind: 'none' },
    needs: 'api-key',
    modelSelectable: true
  },
  {
    id: 'local-asr',
    label: 'Local ASR (Cohere transcribe)',
    kind: 'engine',
    vendor: 'local',
    dataLeavesMachine: false,
    latency: 'heavy',
    capabilities: caps('audio', 'timestamps', 'diarization'),
    effort: { kind: 'none' },
    needs: 'model-files',
    modelSelectable: false
  },
  {
    id: 'vibevoice',
    label: 'VibeVoice (local)',
    kind: 'engine',
    vendor: 'local',
    dataLeavesMachine: false,
    latency: 'heavy',
    capabilities: caps('audio', 'timestamps', 'diarization'),
    effort: { kind: 'none' },
    needs: 'model-files',
    modelSelectable: false
  },
  {
    id: 'model-host',
    label: 'Model Host',
    kind: 'engine',
    vendor: 'local',
    // Another machine of the owner's: the audio leaves this one.
    dataLeavesMachine: true,
    latency: 'heavy',
    capabilities: caps('audio', 'diarization'),
    effort: { kind: 'none' },
    needs: 'running-server',
    modelSelectable: false
  },
  {
    id: 'pyannote-onnx',
    label: 'Speaker segmentation (ONNX)',
    kind: 'engine',
    vendor: 'local',
    dataLeavesMachine: false,
    latency: 'heavy',
    capabilities: caps('audio', 'diarization'),
    effort: { kind: 'none' },
    needs: 'model-files',
    modelSelectable: false
  },
  {
    id: 'gemini-live',
    label: 'Gemini Live transcription',
    kind: 'engine',
    vendor: 'Google',
    dataLeavesMachine: true,
    latency: 'fast',
    capabilities: caps('audio', 'streaming', 'timestamps'),
    effort: { kind: 'none' },
    needs: 'api-key',
    modelSelectable: false
  }
]

/** Jev (TypeSafe System One): answers scored, chosen and yes-or-no questions, fast and cheap. It writes no text. */
export const JEV_DESCRIPTOR: HarnessDescriptor = {
  id: 'jev',
  label: 'Jev (System One)',
  kind: 'special',
  vendor: 'TypeSafe AI',
  dataLeavesMachine: true,
  latency: 'fast',
  capabilities: caps('classification'),
  effort: { kind: 'none' },
  needs: 'api-key',
  modelSelectable: false
}
