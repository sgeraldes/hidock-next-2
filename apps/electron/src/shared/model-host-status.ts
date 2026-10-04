/**
 * The Model Host's state as one sentence, for Settings > Transcription and the voice evidence
 * panel in Settings > Speakers & voices. Shared because the main process builds the status and
 * the renderer says it, and the two must not drift into two vocabularies.
 *
 * Since host 0.3.0 the gamestation's tray icon stops the whole service when it is paused, in use
 * or running a game, so all of those look the same from here: no answer.
 */

export type ModelHostStepAside = 'any-use' | 'games' | 'never'

export interface ModelHostSetupReport {
  /** The host runs the voice model once, with the token HiDock sent, before it diarizes. */
  status: 'needs-token' | 'not-validated' | 'validating' | 'repairing' | 'ready' | 'failed'
  reason?: string
  device?: string
}

export interface ModelHostHealthReport {
  version: string
  state: 'stopped' | 'ready' | 'paused' | 'busy'
  capabilities: string[]
  acceleration?: 'cuda' | 'cpu'
  gpu?: { name: string; vramMiB: number | null; driver: string } | null
  reason?: string
  /** From host 0.3.0, to a paired client. */
  setup?: ModelHostSetupReport
  stepAside?: ModelHostStepAside
  pairing?: { automatic: boolean; remainingMs: number; cancelled: boolean; paired: number }
}

/** What the host's /diagnostics says: the end of its logs and whether torch sees CUDA. */
export interface ModelHostDiagnostics {
  version?: string
  setup?: ModelHostSetupReport
  setupLog?: string
  serviceLog?: string
  repairLog?: string
  torch?: { torch?: string; cudaBuild?: string | null; cudaAvailable?: boolean; device?: string | null; error?: string }
}

export interface ModelHostStatus {
  /** An address is saved. */
  configured: boolean
  /** This computer holds a token from that host. */
  paired: boolean
  /** The chosen speaker engine sends work to a host ('auto' or 'model-host'). */
  usedForSpeakers: boolean
  /** This computer has a Hugging Face token to send. */
  hasHfToken: boolean
  address: string
  /** null: it did not answer. */
  health: ModelHostHealthReport | null
}

export interface ModelHostSentence {
  tone: 'none' | 'working' | 'paused' | 'off'
  text: string
}

const HERE = 'Speaker work runs on this computer'

/** The host has an NVIDIA GPU, but the voice model ran on its CPU: torch without CUDA. Repair fixes it. */
export function cpuDespiteGpu(health: ModelHostHealthReport | null | undefined): boolean {
  return Boolean(health?.gpu && health.setup?.status === 'ready' && health.setup.device === 'cpu')
}

export function describeModelHost(status: ModelHostStatus): ModelHostSentence {
  if (!status.configured) return { tone: 'none', text: `No model host. ${HERE}.` }
  const name = status.address
  if (!status.paired) return { tone: 'off', text: `${name} is not paired with this computer yet. ${HERE}.` }
  if (!status.usedForSpeakers) {
    return {
      tone: 'none',
      text: `${name} is paired, but the speaker engine chosen in Speakers & voices runs on this computer, so nothing goes there.`
    }
  }

  const health = status.health
  if (!health) return { tone: 'off', text: `${name} is not answering: paused, in use or off. ${HERE}.` }

  const setup = health.setup
  if (setup && setup.status !== 'ready') {
    switch (setup.status) {
      case 'needs-token':
        return status.hasHfToken
          ? { tone: 'paused', text: `${name} is waiting for the Hugging Face token from this computer. Press Check to send it.` }
          : { tone: 'off', text: `${name} needs a Hugging Face token and this computer has none. Add it in Settings > Secrets.` }
      case 'failed':
        return { tone: 'off', text: `${name} could not run the voice model: ${setup.reason || 'no reason given'}. ${HERE}.` }
      case 'repairing':
        return { tone: 'paused', text: `${name} is reinstalling its GPU runtime (a few minutes). Speaker work runs here meanwhile.` }
      default:
        return {
          tone: 'paused',
          text: `${name} is testing the voice model with the token from this computer. Speaker work runs here meanwhile.`
        }
    }
  }
  if (!health.capabilities.includes('diarize')) {
    return { tone: 'off', text: `${name} answers, but its setup has not finished. ${HERE}.` }
  }

  if (cpuDespiteGpu(health)) {
    return {
      tone: 'paused',
      text: `${name} works, but on its CPU: its runtime does not see the ${health.gpu!.name}. Press Repair to reinstall it.`
    }
  }

  switch (health.state) {
    case 'ready':
      return { tone: 'working', text: `${name} is working: speaker work goes there.` }
    case 'busy':
      return { tone: 'working', text: `${name} is working on a recording.` }
    case 'stopped':
    case 'paused':
      return { tone: 'off', text: `${name} is ${health.state}. ${HERE} meanwhile.` }
    default:
      // A newer or older host may report a state this build has no words for.
      return {
        tone: 'off',
        text: `${name} answers, but in a state this version does not know (${String(health.state)}). ${HERE}.`
      }
  }
}
