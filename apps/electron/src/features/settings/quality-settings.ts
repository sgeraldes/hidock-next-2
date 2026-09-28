/**
 * Settings > Quality checks: the thresholds that were hardcoded constants
 * (28-sep-2026). Each is one key of the `quality` config section. The default
 * shown next to it comes from the main process (config:get-defaults), and the
 * limits come from src/shared/quality-bounds.ts, the table the main process
 * clamps saved values to, so the two cannot disagree.
 */
import type { AdvancedSetting } from './advanced-settings'
import { QUALITY_BOUNDS, type QualityBoundKey } from '@/shared/quality-bounds'

const RECOMPUTED = 'Saved warnings are recomputed when you change it.'
const FROM_NOW_ON = 'Applies from now on.'

export const QUALITY_GROUPS: string[] = [
  'Audio versus transcript',
  'Jev',
  'Ratings and re-transcription',
  'Meetings',
  'Live transcription'
]

const ENTRIES: AdvancedSetting[] = [
  {
    section: 'quality', key: 'quietSoundShare', group: 'Audio versus transcript', kind: 'number', step: 0.01,
    label: 'Quiet file: share of sound',
    detail: `A file with less sound than this share (0.05 is 5%) counts as quiet. A quiet file with a meaningful transcript is marked "may be invented". ${RECOMPUTED}`
  },
  {
    section: 'quality', key: 'quietMinDurationSeconds', group: 'Audio versus transcript', kind: 'number', step: 10, unit: 's',
    label: 'Quiet file: shortest length',
    detail: `The share of sound above is only checked on files at least this long. ${RECOMPUTED}`
  },
  {
    section: 'quality', key: 'meaningfulWords', group: 'Audio versus transcript', kind: 'number', step: 10, unit: 'words',
    label: 'Meaningful transcript: words',
    detail: `A transcript with at least this many words counts as meaningful. ${RECOMPUTED}`
  },
  {
    section: 'quality', key: 'meaningfulStars', group: 'Audio versus transcript', kind: 'number', step: 1, unit: 'stars',
    label: 'Meaningful transcript: stars',
    detail: `A recording Jev rated at least this many stars also counts as meaningful. ${RECOMPUTED}`
  },
  {
    section: 'quality', key: 'maxWordsPerMinuteOfRecording', group: 'Audio versus transcript', kind: 'number', step: 10, unit: 'words per minute',
    label: 'Fastest believable speech',
    detail: `A transcript with more words per minute of recording than this is marked "may be invented". ${RECOMPUTED}`
  },
  {
    section: 'quality', key: 'busySoundSeconds', group: 'Audio versus transcript', kind: 'number', step: 10, unit: 's',
    label: 'Busy file: seconds of sound',
    detail: `A file with at least this much sound is checked for missing words. ${RECOMPUTED}`
  },
  {
    section: 'quality', key: 'minWordsPerMinuteOfSound', group: 'Audio versus transcript', kind: 'number', step: 1, unit: 'words per minute',
    label: 'Busy file: fewest words',
    detail: `A busy file with fewer words per minute of sound than this is marked "may be missing". ${RECOMPUTED}`
  },
  {
    section: 'quality', key: 'inventedProbability', group: 'Jev', kind: 'number', step: 0.05,
    label: 'Invented transcript probability',
    detail: 'When Jev puts the chance that a transcript is invented at or above this, the Library marks it "may be invented". The Library uses the new value at once.'
  },
  {
    section: 'quality', key: 'reasonProbability', group: 'Jev', kind: 'number', step: 0.05,
    label: 'Reason probability',
    detail: 'A reason, such as "no substance", is attached when Jev puts its chance at or above this. Saved evaluations get their reasons again from the answers Jev already gave, with no new Jev call. Ratings already applied keep the reasons they were given.'
  },
  {
    section: 'quality', key: 'lowValueMaxSeconds', group: 'Ratings and re-transcription', kind: 'number', step: 5, unit: 's',
    label: 'Low value below',
    detail: `Recordings shorter than this are rated low value by their length alone, and are not sent to Jev. ${FROM_NOW_ON}`
  },
  {
    section: 'quality', key: 'maxRetries', group: 'Ratings and re-transcription', kind: 'number', step: 1, unit: 'attempts',
    label: 'Transcription retries',
    detail: `How many times a failed transcription is tried again before the recording is marked failed. ${FROM_NOW_ON}`
  },
  {
    section: 'quality', key: 'retranscribeScore', group: 'Ratings and re-transcription', kind: 'number', step: 5,
    label: 'Re-transcription score',
    detail: `An old transcript scoring at least this (0 to 100) on importance is recommended for a new transcription from the audio. ${FROM_NOW_ON}`
  },
  {
    section: 'quality', key: 'meetingAutoLinkProbability', group: 'Meetings', kind: 'number', step: 0.05,
    label: 'Meeting link probability',
    detail: `A recording is linked to a calendar meeting by what was said only when Jev is at least this sure. ${FROM_NOW_ON}`
  },
  {
    section: 'quality', key: 'meetingAutoLinkMargin', group: 'Meetings', kind: 'number', step: 0.05,
    label: 'Meeting link margin',
    detail: `How far ahead of the second-best meeting the best one must be. ${FROM_NOW_ON}`
  },
  {
    section: 'quality', key: 'liveSilenceRms', group: 'Live transcription', kind: 'number', step: 1, unit: 'RMS',
    label: 'Silence level',
    detail: 'A live channel quieter than this is not sent for transcription. 58 is about -55 dBFS. A running session uses the new value at once.'
  }
]

export const QUALITY_SETTINGS: AdvancedSetting[] = ENTRIES.map((setting) => {
  const bounds = QUALITY_BOUNDS[setting.key as QualityBoundKey]
  return { ...setting, min: bounds.min, max: bounds.max, integer: bounds.integer }
})
