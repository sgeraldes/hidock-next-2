/** Host features are distinct from native firmware support and measured routing. */
export interface DeviceAudioStartOptions {
  transcribe?: boolean
  saveRecording?: boolean
}

export interface DeviceAudioSessionState {
  sessionId: string | null
  status: 'idle' | 'starting' | 'streaming' | 'paused' | 'stopping'
  transcribe: boolean
  saveRecording: boolean
  transcriptionError: string | null
  recordingError: string | null
}

export interface DeviceRecordingCapabilities {
  model: string
  firmwareVersion: string | null
  live: { available: boolean; evidence: 'host-version-gate'; format: 'host-expectation'; sampleRate: 16000; channels: 2; bitDepth: 16 }
  native: {
    /** The generic stock profile API remains unsupported. Custom controls are separate. */
    profileControl: false; markerInsertion: boolean; profiles: []; sourceMapping: 'unverified'
    customRecordingControls?: {
      available: boolean; evidence: 'audited-firmware-gate'
      totalMp3BitratesKbps: [64, 96, 128, 160]; formats: ['mp3', 'wav']; channels: 2
    }
  }
  host: { captureWithoutProvider: true; stereoWav: true; trackExport: true; localMarkers: true }
}

export interface DeviceAudioDiagnosticsState {
  owned?: boolean
  session: DeviceAudioSessionState
  lastSessionId: string | null
  diagnostics: {
    format: { sampleRate: number; channels: number; bitsPerSample: number; encoding: 'pcm16le'; provenance: 'host-expectation'; physicalSourceMapping: 'unverified' }
    channelIds: ['channel-0', 'channel-1']
    packets: number; acceptedPackets: number; rejectedPackets: number; rejectedBytes: number; mutedPackets: number
    frames: number; sampleElapsedMs: number
    firstReceivedAtMs: number | null; lastReceivedAtMs: number | null; maximumArrivalGapMs: number
    lastRest: number | null; maximumRest: number
    channels: Array<{ id: string; rms: number; peak: number; clippedSamples: number; activeSamples: number }>
    correlation: number | null
    windowDelay: { frames: number; correlation: number; maximumLagFrames: number; windowFrames: number } | null
    discontinuities: Array<{ reason: string; atFrame: number }>
    discontinuityCount: number; droppedDiscontinuityDetails: number; sourceIsolation: 'unverified'
  }
}

export interface DeviceAudioTrackExport {
  sampleRate: number; frames: number; seconds: number
  tracks: Array<{ channelId: string; channelIndex: number; path: string }>
  physicalSourceMapping: 'unverified'
}
