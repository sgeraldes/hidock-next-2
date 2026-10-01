/**
 * Which plan a step runs. Phase 2a has no configuration, so the answer is the default plan; phase 3
 * installs a source that reads the owner's `pipeline` settings and returns null for a step the owner has
 * not changed.
 */
import { DEFAULT_PLANS, type Plan, type TextStepId } from './steps'

export type PlanSource = (step: TextStepId) => Plan | null

let source: PlanSource | null = null

export function setPlanSource(next: PlanSource | null): void {
  source = next
}

export function resolvePlan(step: TextStepId): Plan {
  return source?.(step) ?? DEFAULT_PLANS[step]
}
