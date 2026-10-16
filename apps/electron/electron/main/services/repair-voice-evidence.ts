export interface VoiceObservation {
  label: string; model: string; version: string; dimension: number;
  embedding: unknown; speechSeconds: number | null
}

/** Compare recording-local observations only within the same acoustic space. */
export function compareRepairVoices(observations: VoiceObservation[]) {
  const valid = observations.slice(0, 16).flatMap(row => {
    const vector = row.embedding
    if (!Array.isArray(vector) || vector.length !== row.dimension || row.dimension < 1 || row.dimension > 4096
      || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) return []
    const norm = Math.sqrt(vector.reduce((sum, value: number) => sum + value * value, 0))
    return norm > 0 ? [{ ...row, vector: vector as number[], norm }] : []
  })
  const comparisons: Array<{ a: string; b: string; cosineSimilarity: number }> = []
  for (let a = 0; a < valid.length; a++) for (let b = a + 1; b < valid.length; b++) {
    const left = valid[a], right = valid[b]
    if (left.model !== right.model || left.version !== right.version || left.dimension !== right.dimension) continue
    const dot = left.vector.reduce((sum, value, index) => sum + value * right.vector[index], 0)
    comparisons.push({ a: left.label, b: right.label,
      cosineSimilarity: Math.max(-1, Math.min(1, dot / left.norm / right.norm)) })
  }
  return {
    comparisons,
    observations: valid.map(({ label, model, version, dimension, speechSeconds }) =>
      ({ label, model, version, dimension, speechSeconds })),
    basis: 'recording-average-acoustic-embeddings',
    confidenceCalibrated: false,
    limitation: 'Group-average similarity is not an identity probability and cannot prove that a group is unmixed.'
  }
}
