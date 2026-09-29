/**
 * Whether a Jev job may run: a key is set, the Jev switch is on, and the job's
 * own switch is on (Settings > Decisions (Jev)).
 */

import { getConfig } from './config'

export type JevJob = 'value' | 'meetingMatch' | 'speakerNames'

const JOB_FLAG: Record<JevJob, 'jevValue' | 'jevMeetingMatch' | 'jevSpeakerNames'> = {
  value: 'jevValue',
  meetingMatch: 'jevMeetingMatch',
  speakerNames: 'jevSpeakerNames'
}

/** The Jev key when this job may run, else null. */
export function jevKeyFor(job: JevJob): string | null {
  const config = getConfig()
  const key = String(config.transcription?.jevApiKey ?? '').trim()
  if (!key) return null
  const decisions = config.decisions
  if (decisions?.jevEnabled === false) return null
  if (decisions?.[JOB_FLAG[job]] === false) return null
  return key
}
