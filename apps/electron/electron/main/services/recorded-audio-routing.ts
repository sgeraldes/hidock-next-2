import { TranscriptionCancelledError } from '@hidock/transcription'
import { stageFingerprint } from './stage-checkpoints'
import type { AudioPreflightReport } from './audio-preflight'
import type { RemoteAudioChannelMap } from './remote-worker-jobs'
import type { RecordedAudioRoleMapping } from '../../../src/shared/recorded-audio-layout'

export function recordedAudioStageFingerprint(hash: string, separate: boolean, mapping: RemoteAudioChannelMap = []): string {
  return separate ? stageFingerprint('recorded-audio-channels-v1', hash, mapping) : hash
}

export function recordedAudioRemoteMap(mapping?: RecordedAudioRoleMapping | null): RemoteAudioChannelMap {
  return mapping ? mapping.roles.map((role, index) => ({ sourceChannel: index as 0 | 1, role,
    evidence: mapping.evidence === 'user-confirmed' ? 'user-confirmed' : 'firmware-manifest' })) : []
}

export async function withAudioEligibility<T>(shouldContinue: () => boolean,
  action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!shouldContinue()) throw new TranscriptionCancelledError()
  const controller = new AbortController()
  const timer = setInterval(() => {
    try { if (!shouldContinue()) controller.abort() } catch { controller.abort() }
  }, 250)
  timer.unref()
  try {
    const result = await action(controller.signal)
    if (controller.signal.aborted || !shouldContinue()) throw new TranscriptionCancelledError()
    return result
  } finally { clearInterval(timer) }
}

/** Union activity across source clocks; opposite-phase channels must not cancel each other. */
export function combineChannelActivity(reports: AudioPreflightReport[]): AudioPreflightReport {
  if (!reports.length) throw new Error('No channel activity reports')
  const seconds = Math.max(...reports.map(row => row.durationSeconds))
  const merged: Array<{ start: number; end: number; duration: number }> = []
  for (const interval of reports.flatMap(row => row.activityIntervals).sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && interval.start <= last.end) { last.end = Math.max(last.end, interval.end); last.duration = last.end - last.start }
    else merged.push({ ...interval })
  }
  const nonSilentSeconds = merged.reduce((sum, row) => sum + row.duration, 0)
  const levels = (key: 'meanVolumeDb' | 'maxVolumeDb') => reports.map(row => row[key]).filter((value): value is number => value !== null)
  return { ...reports[0], status: reports.some(row => row.status === 'speech_present') ? 'speech_present' : 'no_speech',
    durationSeconds: seconds, activityIntervals: merged, nonSilentSeconds,
    silenceSeconds: Math.max(0, seconds - nonSilentSeconds), nonSilentRatio: nonSilentSeconds / seconds,
    meanVolumeDb: levels('meanVolumeDb').length ? Math.max(...levels('meanVolumeDb')) : null,
    maxVolumeDb: levels('maxVolumeDb').length ? Math.max(...levels('maxVolumeDb')) : null,
    reasonCodes: ['separate-channel-activity-union', ...new Set(reports.flatMap(row => row.reasonCodes))] }
}
