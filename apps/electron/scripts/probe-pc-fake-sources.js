// Run via test-pc-capture.cjs with the fake-devices argument. Diagnostics only:
// Chromium's fake display audio is not evidence of Windows hardware loopback.
(async () => {
  const context = new AudioContext()
  await context.resume()
  const mic = await navigator.mediaDevices.getUserMedia({ audio: {
    deviceId: 'default', echoCancellation: false, noiseSuppression: false, autoGainControl: false
  } })
  const system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  const nodes = [mic, system].map(stream => {
    const analyser = context.createAnalyser()
    analyser.fftSize = 32768
    context.createMediaStreamSource(stream).connect(analyser)
    return analyser
  })
  await new Promise(resolve => setTimeout(resolve, 3500))
  const report = nodes.map((analyser, index) => {
    const frequencies = new Float32Array(analyser.frequencyBinCount)
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatFrequencyData(frequencies)
    analyser.getFloatTimeDomainData(samples)
    return {
      source: index ? 'display' : 'microphone',
      settings: [mic, system][index].getAudioTracks()[0].getSettings(),
      peaks: [...frequencies.keys()].sort((a, b) => frequencies[b] - frequencies[a]).slice(0, 8)
        .map(i => ({ hz: i * context.sampleRate / analyser.fftSize, db: frequencies[i] })),
      rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    }
  })
  ;[mic, system].forEach(stream => stream.getTracks().forEach(track => track.stop()))
  await context.close()
  return report
})()
