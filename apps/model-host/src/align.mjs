/**
 * Word timestamps for "Fix times" in HiDock: Parakeet hears a short section of
 * a recording and says when each word starts and ends. HiDock matches those
 * words to the lines it already has; the host never sees the transcript.
 *
 * Runs on the prepared Parakeet ONNX runtime (sherpa-onnx, CPU) under the same
 * process budget, timeout and cancellation as every other job, and only where
 * Parakeet passed its spoken test and its runtime fingerprint still matches.
 */

import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { runDiarization } from './diarize.mjs'
import { hostRoot } from './config.mjs'
import { ONNX_ASR } from './asr-catalog.mjs'

export const ALIGN_MODEL = 'nvidia/parakeet-tdt-0.6b-v3'

/** Alignment rides on Parakeet's own readiness proof; there is no second model to prepare. */
export function alignmentModels(asrModels) {
  return Array.isArray(asrModels) && asrModels.includes(ALIGN_MODEL) ? [ALIGN_MODEL] : []
}

export function parseAlignOutput(stdout) {
  const result = JSON.parse(stdout)
  const words = result?.words
  const valid = result && result.model === ALIGN_MODEL && typeof result.modelVersion === 'string' && Array.isArray(words) &&
    words.every((w, i) => w && typeof w.word === 'string' && w.word.trim() !== '' &&
      Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end >= w.start &&
      (i === 0 || w.start >= words[i - 1].start))
  if (!valid) throw new Error('Alignment worker returned an incomplete result')
  return result
}

export async function runAlignment(audio, options) {
  const root = options.hostRoot || hostRoot()
  const worker = join(dirname(fileURLToPath(import.meta.url)), 'align_worker.py')
  // The worker decodes the section into this folder. It is the host's to remove, so the
  // decoded audio goes even when the worker is killed by a timeout or a cancel.
  const scratch = await mkdtemp(join(tmpdir(), 'hidock-align-'))
  try {
    return await runDiarization(audio, { ...options,
      workerArgs: path => [worker, '--audio', path, '--worker-dir', dirname(options.workerPath),
        '--model-dir', join(root, 'models', ONNX_ASR[ALIGN_MODEL].directory),
        '--site-dir', join(root, 'runtime', 'asr-onnx', 'site'), '--temp-dir', scratch],
      parseOutput: parseAlignOutput })
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(error =>
      console.error('[align] Could not remove the decoded section:', error.message))
  }
}
