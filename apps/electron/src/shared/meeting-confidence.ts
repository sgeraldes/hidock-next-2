/** Existing calendar correlation and credible-overlap floor (50%). */
export const MIN_MEETING_CONFIDENCE = 0.5
export function meetingCandidateConfidence(candidate: { confidenceScore: number; contentProbability?: number | null }): number {
  return typeof candidate.contentProbability === 'number' ? candidate.contentProbability : candidate.confidenceScore
}
