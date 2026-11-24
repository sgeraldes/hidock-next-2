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
  private persistenceFailed = false
  private terminalStop = false
  private resolveStop: (() => void) | null = null
  private trackListeners: Array<{ track: MediaStreamTrack; ended: () => void }> = []
  constructor(private readonly bridge: PcRecorderBridge, private readonly onError: (message: string) => void) {}

  async start(): Promise<void> {
    if (this.starting || this.recorder || this.context) throw new Error('A recording is already active')
    this.starting = true
    this.failure = null
    this.persistenceFailed = false
    this.pending = Promise.resolve()
    this.index = 0
    this.stopPromise = null
    this.terminalStop = false
    try {
      // Request display capture before awaiting a permission prompt: Chromium
      // requires transient user activation for getDisplayMedia.
      const displayRequest = navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1 } })
      const micRequest = (async () => navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: 'default', echoCancellation: false, noiseSuppression: false, autoGainControl: false
      } }))()
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
      this.streams.push(destination.stream)
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
        const session = this.session
        this.pending = this.pending.then(async () => {
          if (this.persistenceFailed) return
          const data = new Uint8Array(await event.data.arrayBuffer())
          if (this.session !== session) return
          await this.bridge.append(session, index, data)
        }).catch((error: unknown) => { this.persistenceFailed = true; this.fail(error) })
      }
      recorder.onstop = () => {
        this.terminalStop = true
        if (this.resolveStop) this.resolveStop()
        else this.fail(new Error('Audio recording stopped unexpectedly. Saving captured audio.'))
      }
      recorder.onerror = () => this.fail(new Error('Audio recording failed; saved chunks will be recovered on restart'))
      for (const [channel, stream] of [mic, system].entries()) {
        for (const track of stream.getAudioTracks()) {
          const ended = () => this.fail(new Error(`${channel === 0 ? 'Microphone' : 'System audio'} source stopped. Saving captured audio.`))
          this.trackListeners.push({ track, ended })
          track.addEventListener('ended', ended, { once: true })
        }
      }
      if ([mic, system].some((stream) => stream.getAudioTracks().some((track) => track.readyState === 'ended'))) {
        throw new Error('An audio source stopped before recording could start')
      }
      recorder.start(1000)
    } catch (error) {
      if (this.session) {
        await this.bridge.finish(this.session).catch(() => undefined)
        this.session = ''
      }
      this.recorder = null
      await this.release()
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
      if (!this.terminalStop) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.failure ??= new Error('Audio recording stop timed out; saved chunks retained')
            this.resolveStop = null
            resolve()
          }, 5000)
          this.resolveStop = () => { clearTimeout(timeout); this.resolveStop = null; resolve() }
          try { if (recorder.state !== 'inactive') recorder.stop() }
          catch (error) { this.failure ??= error instanceof Error ? error : new Error(String(error)); this.resolveStop() }
        })
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.failure ??= new Error('Audio recording flush timed out; saved chunks retained')
          this.persistenceFailed = true
          resolve()
        }, 3000)
        void this.pending.finally(() => { clearTimeout(timeout); resolve() })
      })
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      await this.release()
      const result = await this.bridge.finish(this.session)
      if (!result.success) throw new Error(result.error ?? 'Recording could not be imported; it will be recovered on restart')
      if (this.failure) throw this.failure
    } finally {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
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
    this.trackListeners.splice(0).forEach(({ track, ended }) => track.removeEventListener('ended', ended))
    this.streams.splice(0).forEach((stream) => stream.getTracks().forEach((track) => track.stop()))
    this.analysers = []
    const context = this.context
    this.context = null
    try { await context?.close() }
    catch (error) { console.error('[PcRecorder] AudioContext cleanup failed:', error) }
  }
}
