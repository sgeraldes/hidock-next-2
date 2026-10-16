import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, updateConfigFile } from './config.mjs'
import { NATIVE_DIARIZATION_MODEL, runNativeDiarization, nativeDiarizationFingerprint } from './native-diarization.mjs'

const [root, sample] = process.argv.slice(2)
if (!root || !sample) throw new Error('Expected host root and spoken test WAV')
const install = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'config.json')
const config = loadConfig(file)
const pythonPath = config.pythonPath || join(root, 'runtime', 'python', 'python.exe')
const result = await runNativeDiarization(sample, { hostRoot: root, pythonPath,
  workerPath: join(install, 'resources', 'speaker-linking', 'worker.py'), model: NATIVE_DIARIZATION_MODEL,
  cpuPercent: config.cpuPercent || 50, timeoutMs: 120000, ffmpegPath: join(install, 'ffmpeg.exe') })
if (!result.segments.length || result.device !== 'cuda') throw new Error('Native diarization speech test failed')
const latest = loadConfig(file)
updateConfigFile({ diarizationValidation: { ...latest.diarizationValidation,
  [NATIVE_DIARIZATION_MODEL]: { testedAt: new Date().toISOString(), modelVersion: result.modelVersion,
    device: result.device, fingerprint: nativeDiarizationFingerprint(pythonPath, root) } } }, file)
console.log('Native diarization speech test passed on CUDA; accuracy remains a separate benchmark.')
