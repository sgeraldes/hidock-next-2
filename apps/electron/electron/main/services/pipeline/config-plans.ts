/**
 * The owner's configuration as the runner's plan source.
 *
 * A step with no entry has no plan here (null), so it runs on its default, today's routing. A step with an
 * entry gets the plan the entry describes, unless the configuration has an error that touches that step or
 * a profile it uses: an invalid plan is never run (design section 7), the reason is logged once, and the
 * step falls back to its default. Warnings do not block. The configuration is read at call time, so a
 * change from the Pipeline page applies to the next call with no restart.
 */
import { AUTO_PROFILE, validatePipelineConfig, type HarnessInfo, type PipelineConfig } from '../../../../src/shared/pipeline-config'
import type { BrainEffort, BrainId } from '../brains'
import type { PlanSource } from './plans'
import { DEFAULT_PLANS, type DirectProfile, type Plan, type Profile, type TextStepId } from './steps'

export interface ConfigPlanDeps {
  getPipeline: () => PipelineConfig | undefined
  getHarnesses: () => HarnessInfo[]
}

export function createConfigPlanSource(deps: ConfigPlanDeps): PlanSource {
  const reported = new Set<string>()
  const reportOnce = (message: string): void => {
    if (reported.has(message)) return
    reported.add(message)
    console.warn(`[Pipeline] ${message}; the step runs as Automatic.`)
  }

  return (step: TextStepId): Plan | null => {
    const pipeline = deps.getPipeline()
    const stepConfig = pipeline?.steps?.[step]
    if (!pipeline || !stepConfig) return null
    const harnesses = deps.getHarnesses()
    const call = stepConfig.passes?.[0]?.calls?.[0]
    const used = new Set<string>(call ? [call.profile, ...(call.onFail ? [call.onFail.profile] : [])] : [])
    const blocking = validatePipelineConfig(pipeline, harnesses).filter(
      (i) => i.severity === 'error' && (i.step === step || (i.profile !== undefined && used.has(i.profile)) || (i.step === undefined && i.profile === undefined))
    )
    if (blocking.length > 0 || !call) {
      reportOnce(`the plan of "${step}" is invalid (${blocking[0]?.message ?? 'it has no call'})`)
      return null
    }

    const expand = (ref: string): Profile => {
      if (ref === AUTO_PROFILE) return DEFAULT_PLANS[step].calls[0].profile
      const p = pipeline.profiles[ref]
      const info = harnesses.find((h) => h.id === p.harness)
      const direct: DirectProfile = {
        kind: 'direct',
        id: ref,
        harness: p.harness as BrainId,
        // A harness that ignores the model would fail on one (kiro answers --model with an error): leave it out.
        ...(p.model && info?.modelSelectable ? { model: p.model } : {}),
        ...(p.effort ? { effort: p.effort as BrainEffort } : {}),
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {})
      }
      return direct
    }
    return { calls: [{ profile: expand(call.profile), ...(call.onFail ? { onFail: expand(call.onFail.profile) } : {}) }] }
  }
}
