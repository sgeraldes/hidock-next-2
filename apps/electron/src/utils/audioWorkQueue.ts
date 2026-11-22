// Shared across playback and waveform selection. Cancelling native decoding
// cannot free its PCM allocation, so retain the slot until it actually settles.
let tail: Promise<void> = Promise.resolve()
export function queueAudioWork(work: () => Promise<void>, cancelled: () => boolean): Promise<void> {
  const next = tail.then(async () => { if (!cancelled()) await work() })
  tail = next.catch(() => undefined)
  return next
}
