import { createHash } from 'crypto'
import { TranscriptionCancelledError } from '@hidock/transcription'
import { prepareStoredAudioChannels } from './stored-audio-channels'
import type {
  RecordedAudioLayout,
  RecordedAudioChannel,
  RecordedAudioRoleMapping
} from '../../../src/shared/recorded-audio-layout'
export interface ChannelTranscript {
  fullText: string
  speakers?: string
}
export interface RecordedChannelResult<T> {
  channelIndex: number
  trackId: string
  sourceRole: RecordedAudioChannel['sourceRole']
  mappingEvidence: RecordedAudioRoleMapping | null
  status: 'completed' | 'no-speech' | 'empty'
  result: T | null
  unplacedText?: string
}
export async function transcribePreparedChannels<T extends ChannelTranscript>(options: {
  filePath: string
  parentDir: string
  layout?: RecordedAudioLayout
  mapping?: RecordedAudioRoleMapping
  shouldContinue: () => boolean
  transcribe: (track: RecordedAudioChannel) => Promise<T>
  checkpoint?: (channelIndex: number, fingerprint: string, action: () => Promise<T>) => Promise<T>
  isNoSpeech?: (track: RecordedAudioChannel) => Promise<boolean>
  onPrepared?: (prepared: {layout: RecordedAudioLayout; tracks: RecordedAudioChannel[]; transformVersion: string}) => void | Promise<void>
  onTrack?: (track: RecordedAudioChannel, layout: RecordedAudioLayout) => void | Promise<void>
}): Promise<
  T & { audioChannels: { sourceHash: string; layout: RecordedAudioLayout; channelResults: RecordedChannelResult<T>[] } }
> {
  const check = () => {
    if (!options.shouldContinue()) throw new TranscriptionCancelledError()
  }
  check()
  const controller = new AbortController()
  const timer = setInterval(() => {
    try {
      check()
    } catch {
      controller.abort()
    }
  }, 200)
  let prepared: Awaited<ReturnType<typeof prepareStoredAudioChannels>> | undefined
  try {
    prepared = await prepareStoredAudioChannels(options.filePath, options.parentDir, {
      mapping: options.mapping,
      signal: controller.signal
    })
    check()
    if (options.layout && options.layout.originalSha256 !== prepared.layout.originalSha256)
      throw new Error('Recording changed before channel transcription')
    await options.onPrepared?.({layout: prepared.layout, tracks: prepared.tracks, transformVersion: prepared.transformVersion})
    check()
    const channelResults: RecordedChannelResult<T>[] = [],
      segments: Array<Record<string, unknown>> = []
    for (const track of prepared.tracks) {
      check()
      await options.onTrack?.(track, prepared.layout)
      check()
      const base = {
        channelIndex: track.channelIndex,
        trackId: track.id,
        sourceRole: track.sourceRole,
        mappingEvidence: track.mappingEvidence
      }
      if (options.isNoSpeech && (await options.isNoSpeech(track))) {
        check()
        channelResults.push({ ...base, status: 'no-speech', result: null })
        continue
      }
      check()
      const fingerprint = createHash('sha256')
        .update(`${track.id}:${JSON.stringify(track.mappingEvidence)}`)
        .digest('hex')
      const action = async () => {
        check()
        const result = await options.transcribe(track)
        check()
        return result
      }
      const result = options.checkpoint
        ? await options.checkpoint(track.channelIndex, fingerprint, action)
        : await action()
      check()
      if (typeof result?.fullText !== 'string') throw new Error('Invalid per-channel transcription result')
      let rows: unknown = []
      if (result.speakers) {
        try {
          rows = JSON.parse(result.speakers)
        } catch {
          throw new Error('Malformed per-channel transcript segments')
        }
      }
      if (!Array.isArray(rows)) throw new Error('Invalid per-channel transcript segments')
      let hasText = false
      for (const value of rows) {
        if (!value || typeof value !== 'object' || typeof value.text !== 'string')
          throw new Error('Invalid per-channel transcript segment')
        if (value.text.trim()) hasText = true
        const timed =
          typeof value.start === 'number' &&
          Number.isFinite(value.start) &&
          value.start >= 0 &&
          typeof value.end === 'number' &&
          Number.isFinite(value.end) &&
          value.end >= value.start
        segments.push({
          ...value,
          speaker: `channel-${track.channelIndex}:${typeof value.speaker === 'string' && value.speaker.trim() ? value.speaker : 'unresolved'}`,
          sourceChannel: track.channelIndex,
          channelRole: track.sourceRole,
          channelProvenance: track.mappingEvidence,
          ...(!timed ? { timestampPlacement: 'unplaced' } : {})
        })
      }
      const unplacedText = !hasText && result.fullText.trim() ? result.fullText : undefined
      if (unplacedText)
        segments.push({
          text: unplacedText,
          speaker: `channel-${track.channelIndex}:unresolved`,
          sourceChannel: track.channelIndex,
          channelRole: track.sourceRole,
          channelProvenance: track.mappingEvidence,
          timestampPlacement: 'unplaced'
        })
      channelResults.push({
        ...base,
        status: result.fullText.trim() || hasText ? 'completed' : 'empty',
        result,
        ...(unplacedText ? { unplacedText } : {})
      })
    }
    check()
    segments.sort((a, b) => {
      const at = a.timestampPlacement === 'unplaced' ? Infinity : Number(a.start),
        bt = b.timestampPlacement === 'unplaced' ? Infinity : Number(b.start)
      return at === bt ? 0 : at - bt
    })
    const primary =
      channelResults.find((row) => row.result?.fullText.trim())?.result ??
      channelResults.find((row) => row.result)?.result
    const aggregate = {
      ...(primary ?? {}),
      fullText: segments
        .filter((s) => String(s.text).trim())
        .map((s) => `[Channel ${Number(s.sourceChannel) + 1}] ${s.text}`)
        .join('\n'),
      speakers: JSON.stringify(segments)
    } as T & Record<string, unknown>
    // Per-provider measurements stay attached to their own channel; never label first-channel usage as the aggregate.
    delete aggregate.usage
    delete aggregate.remoteQuality
    delete aggregate.providerTimeline
    const timeline = channelResults.flatMap((row) => {
      const events = (row.result as Record<string, unknown> | null)?.providerTimeline
      return Array.isArray(events) ? events.map((event) => ({ ...event, sourceChannel: row.channelIndex })) : []
    })
    if (timeline.length) (aggregate as Record<string, unknown>)['providerTimeline'] = timeline
    return {
      ...aggregate,
      audioChannels: { sourceHash: prepared.layout.originalSha256, layout: prepared.layout, channelResults }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new TranscriptionCancelledError()
    throw error
  } finally {
    clearInterval(timer)
    await prepared?.cleanup()
  }
}
