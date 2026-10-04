/**
 * A saved Settings > Quality checks change recomputes stored results only when
 * a rule that produced them changed.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../value-classification', () => ({
  recomputeAudioWarnings: vi.fn(),
  recomputeEvaluationReasons: vi.fn()
}))

import { recomputeForQualityChange } from '../quality-recompute'
import { DEFAULT_QUALITY_RULES, resolveQualityRules } from '../quality-rules'

function jobs() {
  return {
    recomputeAudioWarnings: vi.fn(async () => 4),
    recomputeEvaluationReasons: vi.fn(async () => 2)
  }
}

const base = resolveQualityRules({})

describe('recomputeForQualityChange', () => {
  it('recomputes warnings when a warning key changes, and nothing else', async () => {
    const j = jobs()
    await recomputeForQualityChange(base, resolveQualityRules({ busySoundSeconds: 600 }), j)
    expect(j.recomputeAudioWarnings).toHaveBeenCalledTimes(1)
    expect(j.recomputeEvaluationReasons).not.toHaveBeenCalled()
  })

  it('does not recompute warnings for a key that applies from now on', async () => {
    const j = jobs()
    await recomputeForQualityChange(
      base,
      resolveQualityRules({ maxRetries: 5, retranscribeScore: 70, liveSilenceRms: 80, lowValueMaxSeconds: 40 }),
      j
    )
    expect(j.recomputeAudioWarnings).not.toHaveBeenCalled()
    expect(j.recomputeEvaluationReasons).not.toHaveBeenCalled()
  })

  it('does nothing when the save changed no value', async () => {
    const j = jobs()
    await recomputeForQualityChange(base, resolveQualityRules({}), j)
    expect(j.recomputeAudioWarnings).not.toHaveBeenCalled()
    expect(j.recomputeEvaluationReasons).not.toHaveBeenCalled()
  })

  it('recomputes stored reasons when the reason threshold changes', async () => {
    const j = jobs()
    await recomputeForQualityChange(base, resolveQualityRules({ reasonProbability: 0.6 }), j)
    expect(j.recomputeEvaluationReasons).toHaveBeenCalledTimes(1)
    expect(j.recomputeAudioWarnings).not.toHaveBeenCalled()
  })

  it('logs a failed recompute instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const j = jobs()
    j.recomputeAudioWarnings.mockRejectedValueOnce(new Error('database closed'))
    await expect(recomputeForQualityChange(base, resolveQualityRules({ meaningfulWords: 50 }), j)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith('[Quality] recomputing audio warnings failed:', expect.any(Error))
    error.mockRestore()
  })
})

describe('recompute runs one at a time', () => {
  it('a save during a run queues exactly one more run', async () => {
    let release: () => void = () => undefined
    let runs = 0
    const jobs = {
      recomputeAudioWarnings: vi.fn(async () => {
        runs++
        if (runs === 1) await new Promise<void>((r) => (release = r))
        return 0
      }),
      recomputeEvaluationReasons: vi.fn(async () => 0)
    }
    const next = { ...DEFAULT_QUALITY_RULES, quietSoundShare: 0.1 }
    const first = recomputeForQualityChange(DEFAULT_QUALITY_RULES, next, jobs)
    void recomputeForQualityChange(next, DEFAULT_QUALITY_RULES, jobs)
    void recomputeForQualityChange(DEFAULT_QUALITY_RULES, next, jobs)
    release()
    await first
    expect(jobs.recomputeAudioWarnings).toHaveBeenCalledTimes(2)
  })
})
