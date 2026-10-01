/**
 * The owner's configuration as the runner's plan source.
 *
 * A step with no entry has no plan here (null), so it runs on its default, today's routing. A step with an
 * entry gets the plan the entry describes, unless the configuration has an error that touches that step or
 * a profile it uses: an invalid plan is never run (design section 7), the reason is logged once, and the
 * step falls back to its default. Warnings do not block. The configuration is read at call time, so a
 * change from the Pipeline page applies to the next call with no restart.
 */
import {
  AUTO_PROFILE,
  getProfile,
  issuesForStep,
  validatePipelineConfig,
  type HarnessInfo,
  type PipelineConfig
} from '../../../../src/shared/pipeline-config'
import type { BrainEffort, BrainId } from '../brains'
import type { PlanSource } from './plans'
import { DEFAULT_PLANS, type DirectProfile, type Plan, type Profile, type TextStepId } from './steps'

export interface ConfigPlanDeps {
  getPipeline: () => PipelineConfig | undefined
  getHarnesses: () => HarnessInfo[]
}

export function createConfigPlanSource(deps: ConfigPlanDeps): PlanSource {
  // What was last said about each step: the same reason is not repeated while it lasts, and a plan that is fixed
  // and breaks again is said again.
  const reported = new Map<TextStepId, string>()
  const reportOnce = (step: TextStepId, message: string): void => {
    if (reported.get(step) === message) return
    reported.set(step, message)
    console.warn(`[Pipeline] ${message}; the step runs as Automatic.`)
  }

  return (step: TextStepId): Plan | null => {
    const pipeline = deps.getPipeline()
    const stepConfig = pipeline?.steps?.[step]
    if (!pipeline || !stepConfig) return null
    const harnesses = deps.getHarnesses()
    const call = stepConfig.passes?.[0]?.calls?.[0]
    const blocking = issuesForStep(pipeline, validatePipelineConfig(pipeline, harnesses), step).filter((i) => i.severity === 'error')
    if (blocking.length > 0 || !call) {
      reportOnce(step, `the plan of "${step}" is invalid (${blocking[0]?.message ?? 'it has no call'})`)
      return null
    }
    reported.delete(step)

    const expand = (ref: string): Profile => {
      if (ref === AUTO_PROFILE) return DEFAULT_PLANS[step].calls[0].profile
      const p = getProfile(pipeline, ref)!
      const info = harnesses.find((h) => h.id === p.harness)
      const direct: DirectProfile = {
        kind: 'direct',
        id: ref,
        harness: p.harness as BrainId,
        // A harness that ignores the model would fail on one (kiro answers --model with an error): leave it out.
        ...(p.model && info?.modelSelectable ? { model: p.model } : {}),
        // Likewise an effort for a harness that has no levels.
        ...(p.effort && info?.effortLevels ? { effort: p.effort as BrainEffort } : {}),
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {})
      }
      return direct
    }
    return { calls: [{ profile: expand(call.profile), ...(call.onFail ? { onFail: expand(call.onFail.profile) } : {}) }] }
  }
}
