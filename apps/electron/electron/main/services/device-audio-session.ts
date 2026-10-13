import { randomUUID } from 'crypto'
import type { DeviceAudioSessionState, DeviceAudioStartOptions } from '../../../src/shared/device-audio'

export interface DeviceAudioSessionDeps {
  startDevice: () => Promise<{ result: string } | null>
  pauseDevice: () => Promise<{ result: string } | null>
  stopDevice: () => Promise<{ result: string } | null>
  startTranscription: (ownerId: number) => Promise<void>
  pauseTranscription: () => void
  stopTranscription: () => Promise<void>
  startRecording: (options: DeviceAudioStartOptions, sessionId: string) => string | null | void
  finishRecording: () => void
  beginDiagnostics: () => void
  noteDiscontinuity: (reason: string) => void
}

/** One logical owner; lifecycle changes never overlap or create a second dequeue loop. */
export class DeviceAudioSession {
  private owner: number | null = null
  private pending: Promise<unknown> = Promise.resolve()
  private generation = 0
  private invalidationEpoch = 0
  private value: DeviceAudioSessionState = this.idle()

  constructor(private readonly deps: DeviceAudioSessionDeps) {}

  private idle(): DeviceAudioSessionState {
    return { sessionId: null, status: 'idle', transcribe: false, saveRecording: false, transcriptionError: null, recordingError: null }
  }

  snapshot(): DeviceAudioSessionState { return { ...this.value } }
  owns(ownerId: number): boolean { return this.owner === ownerId && this.value.status !== 'idle' }
  canRead(ownerId: number): boolean { return this.owner === ownerId && this.value.status === 'streaming' }
  get readGeneration(): number { return this.generation }
  noteRecordingFailure(message: string): void {
    if (this.value.status === 'idle') return
    this.value.saveRecording = false
    this.value.recordingError = message
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(action, action)
    this.pending = task.catch(() => undefined)
    return task
  }

  private async stopProvider(): Promise<void> {
    try { await this.deps.stopTranscription() } catch { /* capture cleanup must continue */ }
  }

  start(ownerId: number, options: DeviceAudioStartOptions = {}) {
    const requestedEpoch = this.invalidationEpoch
    return this.exclusive(async () => {
      if (requestedEpoch !== this.invalidationEpoch) return { result: 'failed', error: 'The live connection ended before starting.' }
      if (this.owner !== null && this.owner !== ownerId) return { result: 'failed', error: 'Another window owns the live stream.' }
      if (this.value.status === 'stopping') return { result: 'failed', error: 'The live stream is stopping.' }
      if (this.value.status === 'streaming') return { result: 'success', ...this.snapshot() }
      const resuming = this.value.status === 'paused'
      const generation = ++this.generation
      this.owner = ownerId
      if (!resuming) {
        this.value = { sessionId: randomUUID(), status: 'starting', transcribe: options.transcribe ?? false, saveRecording: options.saveRecording ?? true, transcriptionError: null, recordingError: null }
      } else this.value.status = 'starting'
      try {
        if (!resuming) this.deps.beginDiagnostics()
        const result = await this.deps.startDevice()
        if (generation !== this.generation) return { result: 'failed', error: 'The live connection ended while starting.' }
        if (result?.result !== 'success') throw new Error('The device did not start live audio.')
        this.value.status = 'streaming'
        if (!resuming) {
          try {
            const why = this.deps.startRecording({ transcribe: this.value.transcribe, saveRecording: this.value.saveRecording }, this.value.sessionId!)
            if (why) { this.value.saveRecording = false; this.value.recordingError = why === 'off' ? null : why }
          } catch (error) {
            this.value.saveRecording = false
            this.value.recordingError = error instanceof Error ? error.message : String(error)
          }
        }
        if (this.value.transcribe) {
          this.value.transcriptionError = null
          // Provider connection must never delay the command-34 dequeue loop.
          void Promise.resolve().then(() => {
            if (generation === this.generation) return this.deps.startTranscription(ownerId)
            return undefined
          }).catch(async error => {
            if (generation !== this.generation) return
            this.value.transcriptionError = error instanceof Error ? error.message : String(error)
            await this.stopProvider()
          })
        }
        return { result: 'success', ...this.snapshot() }
      } catch (error) {
        if (generation !== this.generation) return { result: 'failed', error: 'The live connection ended while starting.' }
        await this.stopProvider()
        if (generation !== this.generation) return { result: 'failed', error: 'The live connection ended while starting.' }
        // A failed resume preserves the existing file and permits another resume/stop.
        if (resuming) this.value.status = 'paused'
        else {
          try { this.deps.finishRecording() }
          finally { this.owner = null; this.value = this.idle() }
        }
        return { result: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  pause(ownerId: number) {
    return this.exclusive(async () => {
      if (!this.owns(ownerId)) return { result: 'failed', error: 'This window does not own the live stream.' }
      if (this.value.status === 'paused') return { result: 'success' }
      const generation = this.generation
      let result = await this.deps.pauseDevice()
      if (generation !== this.generation) return { result: 'failed', error: 'The live connection ended while pausing.' }
      let stoppedStream = false
      // H1E 6.3.0 rejects the published pause action. An acknowledged realtime
      // stop can suspend dequeue while retaining the host file/session for resume.
      // A missing reply is inconclusive and must not trigger more commands.
      if (result?.result === 'failed') {
        result = await this.deps.stopDevice()
        if (generation !== this.generation) return { result: 'failed', error: 'The live connection ended while pausing.' }
        stoppedStream = result?.result === 'success'
      }
      if (result?.result === 'success') {
        ++this.generation
        this.value.status = 'paused'
        this.deps.pauseTranscription()
        await this.stopProvider()
        if (this.value.status !== 'paused') return { result: 'failed', error: 'The live connection ended while pausing.' }
        this.deps.noteDiscontinuity(stoppedStream ? 'paused-by-stream-stop' : 'paused')
      }
      return stoppedStream ? { result: 'success', pauseMethod: 'stream-stop-restart', nativePauseResult: 'failed' } : result
    })
  }

  stop(ownerId: number) {
    // Invalidate an in-flight read/start before the queued hardware stop settles.
    if (this.owns(ownerId)) { ++this.generation; ++this.invalidationEpoch; this.value.status = 'stopping' }
    return this.exclusive(async () => {
      if (this.owner !== null && this.owner !== ownerId) return { result: 'failed', error: 'This window does not own the live stream.' }
      if (this.value.status === 'idle') return { result: 'success' }
      this.value.status = 'stopping'
      ++this.generation
      try { return await this.deps.stopDevice() }
      finally {
        try { this.deps.finishRecording() }
        finally {
          await this.stopProvider()
          this.owner = null
          this.value = this.idle()
        }
      }
    })
  }

  /** Disconnect/shutdown invalidates state without attempting fresh USB traffic. */
  endLocally(reason: string): Promise<void> {
    ++this.generation
    ++this.invalidationEpoch
    this.owner = null
    this.value = this.idle()
    // Local teardown must finish even when diagnostic or file callbacks fail.
    try { this.deps.noteDiscontinuity(reason) } catch { /* teardown still owns the resources */ }
    try { this.deps.finishRecording() } catch { /* the recording owner reports its error */ }
    const cleanup = this.stopProvider()
    this.pending = Promise.all([this.pending, cleanup]).then(() => undefined, () => undefined)
    return cleanup
  }
}
