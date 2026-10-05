import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegPath from 'ffmpeg-static'
import { NoSpeechDetectedError, TranscriptionCancelledError, type TranscriptionTraceEvent } from '@hidock/transcription'

/** Five minutes limits output truncation while retaining conversational context. One retry only. */
export const COMPLETENESS_RETRY_CHUNK_SECONDS = 300

interface ChunkTranscript {
  fullText: string
  speakers?: string
  providerTimeline?: TranscriptionTraceEvent[]
}

export async function retryInSmallerChunks(
  audioPath: string,
  durationSeconds: number,
  shouldGenerate: () => boolean,
  transcribe: (path: string, seconds: number, startSeconds: number) => Promise<ChunkTranscript>,
  activity?: Array<{ start: number; end: number }>,
  chunkSeconds = COMPLETENESS_RETRY_CHUNK_SECONDS
): Promise<ChunkTranscript> {
  if (!shouldGenerate()) throw new TranscriptionCancelledError()
  if (!ffmpegPath || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new Error('Smaller-chunk retry requires ffmpeg and a known audio duration')
  }
  const dir = await mkdtemp(join(tmpdir(), 'hidock-completeness-'))
  const turns: Array<{ start: number; end: number; text: string; speaker?: string }> = []
  const timeline: TranscriptionTraceEvent[] = []
  const text: string[] = []
  try {
    for (let start = 0; start < durationSeconds; start += chunkSeconds) {
      if (!shouldGenerate()) throw new TranscriptionCancelledError()
      const seconds = Math.min(chunkSeconds, durationSeconds - start)
      if (activity?.length && !activity.some(s => s.end > start && s.start < start + seconds)) continue
      const path = join(dir, `chunk-${start}.wav`)
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpegPath!.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
          ['-nostdin', '-i', audioPath, '-ss', String(start), '-t', String(seconds), '-ar', '16000', '-c:a', 'pcm_s16le', path],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        child.stderr.on('data', chunk => process.stderr.write(chunk))
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`Completeness retry audio extraction exited ${code}`)))
      })
      if (!shouldGenerate()) throw new TranscriptionCancelledError()
      try {
        const result = await transcribe(path, seconds, start)
        text.push(result.fullText)
        const segments = JSON.parse(result.speakers ?? '[]') as typeof turns
        // Provider labels identify voices only within one request. Acoustic
        // reconciliation after stitching may resolve these distinct labels.
        turns.push(...segments.map(s => ({ ...s, start: s.start + start, end: s.end + start,
          speaker: s.speaker ? `Slice ${Math.floor(start / chunkSeconds) + 1} / ${s.speaker}` : undefined,
          crossSliceIdentity: 'unresolved' })))
        timeline.push(...(result.providerTimeline ?? []).map(event => ({ ...event,
          chunkIndex: Math.floor(start / chunkSeconds), chunkCount: Math.ceil(durationSeconds / chunkSeconds),
          audioStartSec: event.audioStartSec + start, audioEndSec: event.audioEndSec + start })))
      } catch (error) {
        if (!(error instanceof NoSpeechDetectedError)) throw error
        // Silence in a slice does not discard speech in the other slices. The
        // independent completeness check decides whether the whole retry passed.
      }
    }
    return { fullText: text.join('\n'), speakers: JSON.stringify(turns), providerTimeline: timeline }
  } finally {
    // Only this invocation's explicitly named temporary directory.
    await rm(dir, { recursive: true, force: true })
  }
}
