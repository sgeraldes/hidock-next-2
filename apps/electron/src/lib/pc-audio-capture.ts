export interface PcRecorderBridge {
  start(): Promise<string>
  append(id: string, index: number, data: Uint8Array): Promise<void>
  finish(id: string): Promise<{ success: boolean; error?: string }>
}

/** Derived from 7fddc869 audio-capture mic/system capture and chunk-recorder.
 * The old mixer summed sources; this graph instead assigns a mono source to each side.
 */
export class PcAudioCapture {
  private streams: MediaStream[] = []
  private context: AudioContext | null = null
  private recorder: MediaRecorder | null = null
  private session = ''
  private pending: Promise<void> = Promise.resolve()
  private index = 0
  private stopPromise: Promise<void> | null = null
  private starting = false
  private analysers: AnalyserNode[] = []
  private failure: Error | null = null
  constructor(private readonly bridge: PcRecorderBridge, private readonly onError: (message: string) => void) {}

  async start(): Promise<void> {
    if (this.starting || this.recorder) throw new Error('A recording is already active')
    this.starting = true
    this.failure = null
    this.pending = Promise.resolve()
    this.index = 0
    this.stopPromise = null
    try {
      // Request display capture before awaiting a permission prompt: Chromium
      // requires transient user activation for getDisplayMedia.
      const displayRequest = navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1 } })
      const micRequest = navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: 'default', echoCancellation: false, noiseSuppression: false, autoGainControl: false
      } })
      const [micResult, displayResult] = await Promise.allSettled([micRequest, displayRequest])
      if (micResult.status === 'fulfilled') this.streams.push(micResult.value)
      if (displayResult.status === 'fulfilled') this.streams.push(displayResult.value)
      if (micResult.status === 'rejected') throw new Error(`Microphone capture failed: ${String(micResult.reason)}`)
      const mic = micResult.value
      if (!mic.getAudioTracks().length) throw new Error('Microphone capture failed: no audio track')
      let system: MediaStream
      try {
        if (displayResult.status === 'rejected') throw displayResult.reason
        system = displayResult.value
        system.getVideoTracks().forEach((track) => track.stop())
        if (!system.getAudioTracks().length) throw new Error('No system audio track is available')
      } catch (error) {
        throw new Error(`System audio capture failed: ${error instanceof Error ? error.message : String(error)}. Check system audio permissions and try again.`, { cause: error })
      }
      if (!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) throw new Error('Stereo WebM/Opus recording is unavailable')
      const context = new AudioContext()
      this.context = context
      const merger = context.createChannelMerger(2)
      const destination = context.createMediaStreamDestination()
      destination.channelCount = 2
      this.analysers = [mic, system].map((stream, channel) => {
        const source = context.createMediaStreamSource(stream)
        const mono = context.createGain()
        mono.channelCount = 1
        mono.channelCountMode = 'explicit'
        source.connect(mono)
        mono.connect(merger, 0, channel)
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        mono.connect(analyser)
        return analyser
      })
      merger.connect(destination)
      await context.resume()
      this.session = await this.bridge.start()
      const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 })
      this.recorder = recorder
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        const index = this.index++
        this.pending = this.pending.then(async () => {
          const data = new Uint8Array(await event.data.arrayBuffer())
          await this.bridge.append(this.session, index, data)
        }).catch((error: unknown) => { this.fail(error) })
      }
      recorder.onerror = () => this.fail(new Error('Audio recording failed; saved chunks will be recovered on restart'))
      for (const [channel, stream] of this.streams.entries()) {
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => this.fail(new Error(`${channel === 0 ? 'Microphone' : 'System audio'} source stopped. Recording stopped and saved.`)), { once: true })
        }
      }
      recorder.start(1000)
    } catch (error) {
      await this.release()
      if (this.session) {
        await this.bridge.finish(this.session).catch(() => undefined)
        this.session = ''
      }
      this.recorder = null
      throw error
    } finally { this.starting = false }
  }

  levels(): number[] {
    return this.analysers.map((analyser) => {
      const samples = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(samples)
      return Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length))
    })
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.finish()
    return this.stopPromise
  }

  private async finish(): Promise<void> {
    const recorder = this.recorder
    if (!recorder) return
    try {
      if (recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => { recorder.onstop = () => resolve(); recorder.stop() })
      }
      await this.pending
      const result = await this.bridge.finish(this.session)
      if (!result.success) throw new Error(result.error ?? 'Recording could not be imported; it will be recovered on restart')
      if (this.failure) throw this.failure
    } finally {
      this.recorder = null
      this.session = ''
      await this.release()
    }
  }

  private fail(error: unknown): void {
    if (this.failure) return
    this.failure = error instanceof Error ? error : new Error(String(error))
    this.onError(this.failure.message)
    void this.stop().catch(() => undefined)
  }

  private async release(): Promise<void> {
    this.streams.splice(0).forEach((stream) => stream.getTracks().forEach((track) => track.stop()))
    this.analysers = []
    await this.context?.close()
    this.context = null
  }
}
