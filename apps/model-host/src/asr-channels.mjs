import { mkdtemp, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { runDiarization } from './diarize.mjs'

export function channelRequest(request = {}) {
  const channelMode = request.channelMode ?? 'mixed'
  if (!['mixed', 'separate'].includes(channelMode)) throw new Error('Invalid channel mode')
  const input = request.channelMap ?? []
  if (!Array.isArray(input) || input.length > 2) throw new Error('Invalid channel map')
  const seen = new Set()
  const channelMap = input.map(row => {
    if (!row || ![0, 1].includes(row.sourceChannel) || seen.has(row.sourceChannel) ||
        !['unknown', 'microphone', 'system'].includes(row.role) ||
        !['unverified', 'firmware-manifest', 'user-confirmed'].includes(row.evidence) ||
        (row.role !== 'unknown' && row.evidence === 'unverified')) throw new Error('Invalid channel provenance')
    seen.add(row.sourceChannel)
    return { sourceChannel: row.sourceChannel, role: row.role, evidence: row.evidence }
  }).sort((a, b) => a.sourceChannel - b.sourceChannel)
  if (channelMode === 'mixed' && channelMap.length) throw new Error('Channel map requires separate processing')
  let activeChannels
  if (request.activeChannels !== undefined) {
    const active = request.activeChannels
    if (channelMode !== 'separate' || !Array.isArray(active) || active.length < 1 || active.length > 2 ||
        active.some(value => ![0, 1].includes(value)) || new Set(active).size !== active.length) {
      throw new Error('Invalid active channels; separate processing requires one or two unique channel indexes')
    }
    activeChannels = [...active].sort((a, b) => a - b)
  }
  return { channelMode, channelMap, ...(activeChannels ? { activeChannels } : {}) }
}

export function mergeChannelResults(results, manifest, mapping) {
  const segments = []
  for (const { sourceChannel, result } of results) {
    const provenance = mapping.find(row => row.sourceChannel === sourceChannel) ||
      { sourceChannel, role: 'unknown', evidence: 'unverified' }
    const label = speaker => /unresolved|unknown/i.test(speaker) ? 'Speaker unresolved' : `ch${sourceChannel}:${speaker}`
    for (const row of result.segments) {
      if (!(row.start >= 0 && row.end > row.start && row.end <= manifest.durationSeconds + 0.05)) {
        throw new Error('Channel ASR returned timestamps outside source audio')
      }
      segments.push({ ...row, speaker: label(row.speaker), sourceChannel, channelRole: provenance.role,
        channelProvenance: provenance.evidence,
        ...(row.acousticSpeakers ? { acousticSpeakers: row.acousticSpeakers.map(label) } : {}),
        ...(row.acousticTurns ? { acousticTurns: row.acousticTurns.map(turn => ({ ...turn, speaker: label(turn.speaker) })) } : {}) })
    }
  }
  segments.sort((a, b) => a.start - b.start || a.sourceChannel - b.sourceChannel)
  const { speakers: _singleChannelSpeakers, diarizationStatus: _status,
    diarizationUnavailableSegments: _missing, speakerEmbeddingsAvailable: _embeddings, ...base } = results[0].result
  const missing = segments.filter(row => row.diarizationStatus === 'unavailable').length
  const hasDiarization = results.some(row => row.result.diarizationStatus !== undefined)
  return { ...base, channelMode: 'separate', sourceChannels: manifest.channels,
    sourceAudioSha256: manifest.sourceSha256, audioSeconds: manifest.durationSeconds,
    decodedSampleRate: 16000, decodedFrames: Math.round(manifest.durationSeconds * 16000),
    ...(hasDiarization ? { diarizationStatus: missing ? 'degraded' : 'window-scoped-clusters',
      diarizationUnavailableSegments: missing,
      speakerEmbeddingsAvailable: !missing && results.every(row => row.result.speakerEmbeddingsAvailable === true) } : {}),
    activeChannels: results.map(row => row.sourceChannel).sort((a, b) => a - b),
    channelResults: Array.from({ length: manifest.channels }, (_, sourceChannel) => {
      const result = results.find(row => row.sourceChannel === sourceChannel)?.result
      if (!result) return { sourceChannel, status: 'no-activity-skip', segmentCount: 0, policyReason: 'client-energy-preflight' }
      return { sourceChannel, status: 'completed', model: result.model,
      modelVersion: result.modelVersion, device: result.device, segmentCount: result.segments.length,
      wallSeconds: result.wallSeconds, outputTokens: result.outputTokens,
      diarizationStatus: result.diarizationStatus, diarizationUnavailableSegments: result.diarizationUnavailableSegments,
      speakerEmbeddingsAvailable: result.speakerEmbeddingsAvailable }
    }),
    segments, text: segments.map(row => row.text).join('\n'),
    wallSeconds: results.reduce((sum, item) => sum + (item.result.wallSeconds || 0), 0),
    outputTokens: results.every(item => Number.isFinite(item.result.outputTokens))
      ? results.reduce((sum, item) => sum + item.result.outputTokens, 0) : undefined }
}

export async function runSeparateChannels(audio, options, runMono, split = runDiarization) {
  const started = Date.now()
  const deadline = started + (options.timeoutMs || 300000)
  const remaining = () => {
    const value = deadline - Date.now()
    if (value <= 0) throw new Error('Channel ASR operation timed out')
    return value
  }
  const { channelMap, activeChannels } = channelRequest(options)
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hidock-channel-')))
  try {
    const helper = join(dirname(fileURLToPath(import.meta.url)), 'asr_channel_split.py')
    const manifest = await split(audio, { ...options, memoryProfile: undefined,
      timeoutMs: Math.min(remaining(), 300000),
      workerArgs: path => [helper, '--audio', path, '--output-dir', directory, '--worker-dir', dirname(options.workerPath)],
      parseOutput: JSON.parse })
    if (![1, 2].includes(manifest.channels) || !Number.isFinite(manifest.durationSeconds) ||
        manifest.durationSeconds <= 0 || manifest.durationSeconds > 21600 ||
        !/^[a-f0-9]{64}$/.test(manifest.sourceSha256 || '') ||
        !Array.isArray(manifest.tracks) || manifest.tracks.length !== manifest.channels) throw new Error('Invalid channel split manifest')
    if (channelMap.some(row => row.sourceChannel >= manifest.channels)) throw new Error('Channel map refers to absent source channel')
    if (activeChannels?.some(index => index >= manifest.channels)) throw new Error('Active channel refers to absent source channel')
    const results = []
    for (let sourceChannel = 0; sourceChannel < manifest.channels; sourceChannel++) {
      if (options.signal?.aborted) throw new Error('Channel ASR cancelled')
      const expected = join(directory, `channel-${sourceChannel}.wav`)
      if (manifest.tracks[sourceChannel] !== expected || await realpath(expected) !== expected) throw new Error('Unsafe channel output path')
      if (activeChannels && !activeChannels.includes(sourceChannel)) continue
      const result = await runMono(expected, { ...options, timeoutMs: remaining(), extension: '.wav',
        channelMode: 'mixed', channelMap: [], activeChannels: undefined })
      remaining()
      if (options.signal?.aborted) throw new Error('Channel ASR cancelled')
      results.push({ sourceChannel, result })
    }
    return { ...mergeChannelResults(results, manifest, channelMap), wallSeconds: (Date.now() - started) / 1000 }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
