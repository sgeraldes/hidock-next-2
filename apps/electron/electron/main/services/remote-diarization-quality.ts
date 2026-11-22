/** Preserve the provider's explicit missing-label state without inventing speaker identities. */
export function remoteTranscriptFields(result: { text: string; segments: unknown[] }) {
  return { fullText: result.text, speakers: JSON.stringify(result.segments) }
}

export function remoteDiarizationQuality(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof result.diarizationStatus === 'string' ? { diarizationStatus: result.diarizationStatus } : {}),
    ...(Number.isInteger(result.diarizationUnavailableSegments)
      ? { diarizationUnavailableSegments: result.diarizationUnavailableSegments } : {}),
    ...(typeof result.speakerEmbeddingsAvailable === 'boolean'
      ? { speakerEmbeddingsAvailable: result.speakerEmbeddingsAvailable } : {})
  }
}

export function providerDiarizationOutcome(
  assessed: { status: string; reasons?: string[]; [key: string]: unknown },
  remote?: Record<string, unknown>
) {
  const unavailable = remote?.diarizationStatus === 'degraded' || remote?.diarizationStatus === 'unavailable'
  return {
    status: !unavailable && assessed.status === 'high' ? 'completed' as const : 'degraded' as const,
    qualityStatus: unavailable ? 'degraded' : assessed.status,
    quality: { ...assessed, ...remoteDiarizationQuality(remote || {}),
      ...(unavailable ? { reasons: [...(assessed.reasons || []), 'Provider did not supply speaker labels for all segments; transcript retained without trusted speaker identity'] } : {}) }
  }
}
