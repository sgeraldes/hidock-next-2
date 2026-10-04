/**
 * The Model Host's state as one sentence, for Settings > Transcription and the voice evidence
 * panel in Settings > Speakers & voices. Shared because the main process builds the status and
 * the renderer says it, and the two must not drift into two vocabularies.
 */

export interface ModelHostPause {
  /** 'you': someone paused it on that machine. 'game': game mode paused it. */
  by: 'you' | 'game'
  /** What game mode saw ("eldenring.exe is running"). */
  detail?: string
  since?: number
  /** When a game pause lifts if no game starts again; null while the game runs. */
  resumesAt?: number | null
}

export interface ModelHostHealthReport {
  version: string
  state: 'stopped' | 'ready' | 'paused' | 'busy'
  capabilities: string[]
  acceleration?: 'cuda' | 'cpu'
  gpu?: { name: string; vramMiB: number | null; driver: string } | null
  reason?: string
  /** Hosts from 0.2.0 on say who paused them; older ones only say "paused". */
  pause?: ModelHostPause | null
}

export interface ModelHostStatus {
  /** An address is saved. */
  configured: boolean
  /** This computer holds a token from that host. */
  paired: boolean
  /** The chosen speaker engine sends work to a host ('auto' or 'model-host'). */
  usedForSpeakers: boolean
  address: string
  /** null: it did not answer. */
  health: ModelHostHealthReport | null
}

export interface ModelHostSentence {
  tone: 'none' | 'working' | 'paused' | 'off'
  text: string
}

const HERE = 'Speaker work runs on this computer'

/** 23:40: the 24-hour form the rest of the app uses. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
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
  if (!health) return { tone: 'off', text: `${name} is off or not answering. ${HERE}.` }
  if (!health.capabilities.includes('diarize')) {
    return { tone: 'off', text: `${name} answers, but its setup has not finished. ${HERE}.` }
  }

  switch (health.state) {
    case 'ready':
      return { tone: 'working', text: `${name} is working: speaker work goes there.` }
    case 'busy':
      return { tone: 'working', text: `${name} is working on a recording.` }
    case 'stopped':
      return { tone: 'off', text: `${name} is stopped. ${HERE} until someone presses Start there.` }
    case 'paused': {
      const pause = health.pause
      if (pause?.by === 'game') {
        const back = pause.resumesAt
          ? `Back at ${clock(pause.resumesAt)} if no game starts.`
          : 'Back a few minutes after the game closes.'
        const what = pause.detail ? ` (${pause.detail})` : ''
        return { tone: 'paused', text: `${name} is paused for a game${what}. ${back} ${HERE} meanwhile.` }
      }
      if (pause?.by === 'you') {
        return { tone: 'paused', text: `${name} is paused by hand. ${HERE} until it is resumed there.` }
      }
      return { tone: 'paused', text: `${name} is paused. ${HERE} meanwhile.` }
    }
    default:
      // A newer or older host may report a state this build has no words for.
      return {
        tone: 'off',
        text: `${name} answers, but in a state this version does not know (${String(health.state)}). ${HERE}.`
      }
  }
}
