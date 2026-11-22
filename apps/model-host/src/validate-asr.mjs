import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { loadConfig, loadSecrets, updateConfigFile } from './config.mjs'
import { runAsr, ASR_MODELS } from './asr.mjs'
import { asrRuntimeFingerprint } from './asr-readiness.mjs'
import { execFileSync } from 'node:child_process'
import { unlinkSync, mkdirSync } from 'node:fs'

const [root, model, sample] = process.argv.slice(2)
if (!root || !ASR_MODELS.has(model) || !sample) throw new Error('Expected host root, allowed model, and spoken test WAV')
const install = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'config.json')
const config = loadConfig(file)
const pythonPath = config.pythonPath || join(root, 'runtime', 'python', 'python.exe')
// Same supervisor as real work: bounded output, memory, CPU and deadline.
const result = await runAsr(sample, { pythonPath, hostRoot: root,
  workerPath: join(install, 'resources', 'speaker-linking', 'worker.py'),
  model, language: 'en', cpuPercent: config.cpuPercent || 50, timeoutMs: 15 * 60 * 1000,
  ffmpegPath: join(install, 'ffmpeg.exe'), hfToken: loadSecrets(join(root, 'secrets.json')).hfToken })
if (!result.text.trim() || !result.segments.length) throw new Error('No transcript returned for the spoken test')
const latest = loadConfig(file)
updateConfigFile({ asrModels: [...new Set([...(latest.asrModels || []), model])],
  asrValidation: { ...latest.asrValidation, [model]: { testedAt: new Date().toISOString(),
    modelVersion: result.modelVersion, device: result.device, fingerprint: asrRuntimeFingerprint(pythonPath, model, root) } } }, file)
console.log(`ASR test passed on ${result.deviceName || result.device}. Start the host to use ${model}.`)

// Independently test the native runtime's actual partial/final WebSocket contract.
// File-ASR readiness above must not be mistaken for a live HiDock UI integration.
if (model === 'nvidia/nemotron-3.5-asr-streaming-0.6b') {
  const logs = join(root, 'logs')
  mkdirSync(logs, { recursive: true })
  const stamp = Date.now()
  const normalized = join(logs, `nemotron-streaming-${stamp}.wav`)
  const report = join(logs, `nemotron-streaming-${stamp}.json`)
  try {
    execFileSync(join(install, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-threads', '1',
      '-i', sample, '-t', '10', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', normalized],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
    execFileSync(pythonPath, ['-S', join(install, 'src', 'validate_nemotron_streaming.py'),
      '--resource-policy', join(install, 'resources', 'speaker-linking', 'resource_policy.py'),
      '--node', join(install, 'node.exe'), '--harness', join(install, 'src', 'nemo-streaming-check.mjs'),
      '--exe', join(root, 'runtime', 'asr-nemotron', 'nemo-speech-0.2.0-windows-x86_64-cuda', 'bin', 'nemo-speech.exe'),
      '--model', join(root, 'models', 'nemotron-3.5-asr-streaming-0.6b-gguf', 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf'),
      '--audio', normalized, '--out', report, '--language', 'en-US', '--device', 'cuda:0'],
    { windowsHide: true, timeout: 75000, maxBuffer: 1024 * 1024 })
    console.log(`Native streaming partial/final/cancellation test passed: ${report}`)
  } catch (error) {
    console.warn(`File ASR passed, but native streaming remains unverified: ${error.message}. Report: ${report}`)
  } finally {
    try { unlinkSync(normalized) } catch { /* Diagnostic input may not have been created. */ }
  }
}
