/** Preserve left/right routing while independently silencing each decoded channel. */
export function connectStereoPlayback(context: AudioContext, source: AudioNode, output: AudioNode) {
  const splitter = context.createChannelSplitter(2)
  const merger = context.createChannelMerger(2)
  const gains = [context.createGain(), context.createGain()]
  source.connect(splitter)
  gains.forEach((gain, channel) => {
    splitter.connect(gain, channel)
    gain.connect(merger, 0, channel)
  })
  merger.connect(output)
  return {
    setMuted(channel: number, muted: boolean) {
      if (channel !== 0 && channel !== 1) return
      gains[channel].gain.setValueAtTime(muted ? 0 : 1, context.currentTime)
    },
    disconnect() {
      source.disconnect(); splitter.disconnect(); gains.forEach(gain => gain.disconnect()); merger.disconnect()
    }
  }
}
