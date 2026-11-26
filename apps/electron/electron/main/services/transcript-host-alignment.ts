/**
 * Fix times on the model host: cut the stretch of audio where a range of lines
 * belongs, send only that (never the transcript) to the host, where Parakeet
 * says when each word was heard, and lay the lines on those words here.
 *
 * Any reason the host cannot do it (not paired, not answering, stepped aside,
 * Parakeet not ready, a failed job, words that do not match) comes back as a
 * sentence, and the caller uses the speech-stretch aligner on this computer.
 */

import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { alignWordsOnModelHost, type HostAlignmentAnswer, type ModelHostSettings } from './model-host-client'
import type { RemoteJobIdentity, RemoteJobStore } from './remote-worker-jobs'
import { extractWithFfmpeg, sectionBounds } from './transcript-section-transcription'
import { alignLinesToWords, type WordAlignmentResult } from './transcript-word-aligner'
import type { SpeechSpan } from './transcript-time-aligner'

/** Parakeet on the host's CPU hears a 15-minute section in well under a minute; past this the owner is kept waiting. */
export const HOST_ALIGN_TIMEOUT_MS = 120_000

export interface HostFixDeps {
  settings: () => ModelHostSettings | null | Promise<ModelHostSettings | null>
  audioExists: (path: string) => boolean
  extract: (audioPath: string, start: number, seconds: number, outPath: string) => Promise<void>
  align: (clipPath: string, settings: ModelHostSettings, options: Parameters<typeof alignWordsOnModelHost>[2]) => Promise<HostAlignmentAnswer>
  store: (recordingId: string) => RemoteJobStore | Promise<RemoteJobStore>
}

export type HostFixOutcome =
  | { used: true; alignment: WordAlignmentResult; modelVersion: string }
  | { used: false; reason: string }

export interface HostFixInput {
  recordingId: string
  audioPath: string | null
  lines: Array<{ text: string }>
  window: SpeechSpan
  durationSeconds: number | null
}

/**
 * The job identity lives as long as the click. It is never written to the durable
 * checkpoint store: startup recovery would otherwise resume it as pipeline work.
 */
export function memoryJobStore(): RemoteJobStore {
  const identities = new Map<string, RemoteJobIdentity>()
  return { load: (key) => identities.get(key), save: (key, identity) => { identities.set(key, identity) } }
}

const defaultDeps: HostFixDeps = {
  // Lazy: config pulls in Electron.
  settings: async () => {
    const { getConfig } = await import('./config')
    const config = getConfig().transcription
    return config.modelHostUrl?.trim() && config.modelHostToken ? { url: config.modelHostUrl, token: config.modelHostToken } : null
  },
  audioExists: existsSync,
  extract: extractWithFfmpeg,
  align: alignWordsOnModelHost,
  store: memoryJobStore
}

/** Never throws: every failure is a reason, and the caller places the lines on this computer. */
export async function fixTimesOnModelHost(input: HostFixInput, deps: HostFixDeps = defaultDeps): Promise<HostFixOutcome> {
  let dir: string | null = null
  try {
    const settings = await deps.settings()
    if (!settings) return { used: false, reason: 'This computer is not paired with a model host.' }
    if (!input.audioPath || !deps.audioExists(input.audioPath)) return { used: false, reason: 'The audio file is not on this computer.' }
    const bounds = sectionBounds(input.window.start, input.window.end, input.durationSeconds)
    dir = await mkdtemp(join(tmpdir(), 'hidock-align-'))
    const clip = join(dir, 'section.wav')
    await deps.extract(input.audioPath, bounds.start, bounds.seconds, clip)
    const answer = await deps.align(clip, settings, { timeoutMs: HOST_ALIGN_TIMEOUT_MS, recordingId: input.recordingId, store: await deps.store(input.recordingId) })
    const words = answer.words.map((w) => ({ word: w.word, start: w.start + bounds.start, end: w.end + bounds.start }))
    const alignment = alignLinesToWords(input.lines, input.window, words)
    if (!alignment.ok) return { used: false, reason: alignment.reason }
    return { used: true, alignment, modelVersion: answer.modelVersion }
  } catch (err) {
    return { used: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    // Only this invocation's own temporary directory. A failed removal is logged; it never
    // replaces the outcome (CodeRabbit review of #198).
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
        console.warn('[TranscriptTiming] Could not remove the section sent to the model host:', err instanceof Error ? err.message : err))
    }
  }
}
