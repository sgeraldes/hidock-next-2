import { analyzeAudioPreflight } from '../../electron/main/services/audio-preflight'

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) throw new Error('An existing audio path is required')
  const started = Date.now()
  let wanted = true
  const timer = process.argv.includes('--cancel') ? setTimeout(() => { wanted = false }, 25) : undefined
  try {
    const result = await analyzeAudioPreflight(path, undefined, () => wanted)
    console.log(JSON.stringify({ completed: true, elapsedMs: Date.now() - started,
      status: result.status, durationSeconds: result.durationSeconds,
      activityIntervals: result.activityIntervals.length }))
  } catch (error) {
    if (!wanted && error instanceof Error && error.name === 'TranscriptionCancelledError') {
      console.log(JSON.stringify({ cancelled: true, elapsedMs: Date.now() - started }))
    } else throw error
  } finally { clearTimeout(timer) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
