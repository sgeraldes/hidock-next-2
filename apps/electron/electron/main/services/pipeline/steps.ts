/**
 * The steps phase 2a runs and the plan each one has by default.
 *
 * A step is what the owner will configure in Settings (design section 3). Phase 2a knows the text steps
 * that go through `runText` and the steps whose call it only records (`OBSERVED_STEPS`: the handover
 * chooses its own brain, and the Jev steps are not text).
 *
 * A profile is where a call goes. A `router` profile is today's routing, kept exactly: the BrainRouter
 * decides, walks its own chain and applies its own eligibility gates. A `direct` profile names a harness,
 * a model and settings (phase 3 builds these from the owner's configuration). Default plans are all
 * router profiles, so with no configuration nothing moves.
 */
import type { BrainEffort, BrainId, BrainTask } from '../brains'

export const TEXT_STEPS = [
  'chat',
  'rag-summarize',
  'rag-action-items',
  'self-id',
  'speaker-roster',
  'meeting-pick',
  'reformat',
  'notes',
  'outputs'
] as const
export type TextStepId = (typeof TEXT_STEPS)[number]

export const OBSERVED_STEPS = ['handover', 'evaluate', 'meeting-match', 'speaker-names'] as const
export type StepId = TextStepId | (typeof OBSERVED_STEPS)[number]

/** Today's routing: `chat` walks the router's chat chain; `generate` resolves one brain and calls it once. */
export interface RouterProfile {
  kind: 'router'
  task: BrainTask
  mode: 'chat' | 'generate'
}

export interface DirectProfile {
  kind: 'direct'
  /** The profile's name, shown in the ledger. */
  id: string
  harness: BrainId
  model?: string
  effort?: BrainEffort
  temperature?: number
  maxTokens?: number
}

export type Profile = RouterProfile | DirectProfile

export interface PlanCall {
  profile: Profile
  /** Tried once when the profile is unavailable, answers nothing or fails. Not tried for an abort or an ineligible source. */
  onFail?: Profile
}

/** Phase 2a: one pass with one call. Stacked and parallel shapes come with phase 5. */
export interface Plan {
  calls: readonly [PlanCall]
}

const chatRoute = (task: BrainTask): Plan => ({ calls: [{ profile: { kind: 'router', task, mode: 'chat' } }] })

export const DEFAULT_PLANS: Record<TextStepId, Plan> = {
  chat: chatRoute('chat'),
  'rag-summarize': chatRoute('chat'),
  'rag-action-items': chatRoute('chat'),
  'self-id': chatRoute('chat'),
  'speaker-roster': chatRoute('chat'),
  'meeting-pick': chatRoute('chat'),
  reformat: chatRoute('chat'),
  notes: chatRoute('suggestions'),
  outputs: { calls: [{ profile: { kind: 'router', task: 'outputs', mode: 'generate' } }] }
}
