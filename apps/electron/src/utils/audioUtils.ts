/**
 * Audio Processing Utilities
 *
 * Provides utilities for audio decoding and waveform data generation.
 */

// Create singleton AudioContext (prevents exhausting browser's ~6 context limit)
let audioContext: AudioContext | null = null

/**
 * Get or create the singleton AudioContext
 * Reuses the same context to avoid exhausting browser's context limit (~6)
 */
function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

/**
 * Generate waveform data from an AudioBuffer by sampling amplitude peaks
 *
 * @param audioBuffer - Decoded audio buffer from Web Audio API
 * @param sampleCount - Number of waveform samples to generate (default: 1000)
 * @returns Float32Array containing normalized amplitude values (0.0 to 1.0)
 */
export async function generateWaveformData(
  audioBuffer: AudioBuffer,
  sampleCount: number = 1000,
  channel: number = 0
): Promise<Float32Array> {
  // Sample the requested channel; keep one shared block/time grid.
  const rawData = audioBuffer.getChannelData(channel)
  const waveformData = new Float32Array(sampleCount)
  let lastYield = performance.now()

  // Calculate peak amplitude for each block
  for (let i = 0; i < sampleCount; i++) {
    const start = Math.floor(i * rawData.length / sampleCount)
    const end = Math.max(start + 1, Math.floor((i + 1) * rawData.length / sampleCount))
    let max = 0

    // Find peak amplitude in this block
    for (let j = start; j < end && j < rawData.length; j++) {
      const abs = Math.abs(rawData[j])
      if (abs > max) max = abs
    }

    waveformData[i] = max
    if (performance.now() - lastYield >= 8) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      lastYield = performance.now()
    }
  }

  return waveformData
}

/**
 * Decode base64-encoded audio data into an AudioBuffer
 *
 * @param base64Data - Base64-encoded audio file content
 * @param _mimeType - MIME type of the audio (unused, for future use)
 * @returns Decoded AudioBuffer
 */
export async function decodeAudioData(
  base64Data: string,
  _mimeType: string
): Promise<AudioBuffer> {
  // Use singleton audio context instead of creating new one
  const audioContext = getAudioContext()

  // Ensure AudioContext is active (it may start in 'suspended' state
  // if created without a user gesture, causing decodeAudioData to hang)
  if (audioContext.state === 'suspended') {
    let resumeDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        audioContext.resume(),
        new Promise<never>((_, reject) => {
          resumeDeadline = setTimeout(() => reject(new Error('Audio context resume timed out')), 5000)
        })
      ])
    } finally {
      clearTimeout(resumeDeadline)
    }
  }

  // Decode base64 to binary
  const binaryData = atob(base64Data)
  const arrayBuffer = new ArrayBuffer(binaryData.length)
  const uint8Array = new Uint8Array(arrayBuffer)

  for (let i = 0; i < binaryData.length; i++) {
    uint8Array[i] = binaryData.charCodeAt(i)
  }

  // Decode audio data
  return await audioContext.decodeAudioData(arrayBuffer)
}

const AUDIO_MIME_SNIFF_BASE64_CHARS = 24 // At most 18 decoded header bytes.

function sniffAudioMimeType(header: Uint8Array): string | null {
  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => header[index] === byte)
  const asciiAt = (offset: number, value: string) =>
    Array.from(value, (character, index) => header[offset + index] === character.charCodeAt(0)).every(Boolean)

  if (header.length >= 12 && asciiAt(0, 'RIFF') && asciiAt(8, 'WAVE')) return 'audio/wav'
  if (header.length >= 10 && asciiAt(0, 'ID3')) return 'audio/mpeg'
  if (header.length >= 4 && asciiAt(0, 'OggS')) return 'audio/ogg'
  if (header.length >= 4 && asciiAt(0, 'fLaC')) return 'audio/flac'
  if (header.length >= 4 && startsWith(0x1a, 0x45, 0xdf, 0xa3)) return 'audio/webm'
  if (header.length >= 12 && asciiAt(4, 'ftyp')) return 'audio/mp4'

  if (header.length >= 4 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) {
    const version = (header[1] >> 3) & 0x03
    const layer = (header[1] >> 1) & 0x03
    const bitrateIndex = (header[2] >> 4) & 0x0f
    const sampleRateIndex = (header[2] >> 2) & 0x03
    if (version !== 0x01 && layer !== 0 && bitrateIndex !== 0 && bitrateIndex !== 0x0f && sampleRateIndex !== 0x03) {
      return 'audio/mpeg'
    }
  }

  return null
}

function sniffAudioMimeTypeFromBase64(base64Prefix: string): string | null {
  const encodedPrefix = base64Prefix.slice(0, AUDIO_MIME_SNIFF_BASE64_CHARS)
  const completeChunkLength = encodedPrefix.length - (encodedPrefix.length % 4)
  if (completeChunkLength < 4) return null

  try {
    const binaryPrefix = atob(encodedPrefix.slice(0, completeChunkLength))
    const header = Uint8Array.from(binaryPrefix, character => character.charCodeAt(0))
    return sniffAudioMimeType(header)
  } catch {
    // Older or non-base64 callers retain the extension-based fallback below.
    return null
  }
}

/**
 * Get the MIME type from a bounded file header when available, falling back to the extension.
 *
 * @param filePath - Full file path or just the filename/extension
 * @param base64Prefix - Optional base64 file content; only the first 18 bytes are inspected
 * @returns MIME type string (defaults to 'audio/wav' for unknown extensions)
 */
export function getAudioMimeType(filePath: string, base64Prefix?: string): string {
  if (base64Prefix) {
    const detected = sniffAudioMimeTypeFromBase64(base64Prefix)
    if (detected) return detected
  }

  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'mp3':
    case 'hda': // HDA files are MPEG MP3
      return 'audio/mpeg'
    case 'm4a':
      return 'audio/mp4'
    case 'ogg':
      return 'audio/ogg'
    case 'flac':
      return 'audio/flac'
    case 'webm':
      return 'audio/webm'
    default:
      return 'audio/wav'
  }
}

/**
 * Format time in seconds to HH:MM:SS or MM:SS format
 *
 * @param seconds - Time in seconds
 * @returns Formatted time string
 */
export function formatTimestamp(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00'

  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/**
 * Format file size in bytes to human-readable string
 *
 * @param bytes - File size in bytes
 * @returns Formatted file size string (e.g., "1.5 MB")
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}
