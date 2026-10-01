/**
 * The Pipeline page in plain words: what a step runs on, where its text goes, how it has done, and the
 * fields of its editor. Pure functions, so they are tested without a page.
 */
import {
  AUTO_PROFILE,
  getProfile,
  type EffortLevel,
  type HarnessInfo,
  type PipelineConfig,
  type ProfileConfig,
  type StepChoice,
  type StepStats,
  type TextStepId
} from '@/shared/pipeline-config'

/** The fields of one choice in the editor. `harness` is a harness id, `auto`, or empty for "no fallback". */
export interface ChoiceFields {
  harness: string
  model: string
  effort: '' | EffortLevel
}

export interface StepDraftFields {
  primary: ChoiceFields
  fallback: ChoiceFields
}

const NONE: ChoiceFields = { harness: '', model: '', effort: '' }
const AUTOMATIC: ChoiceFields = { harness: AUTO_PROFILE, model: '', effort: '' }

const harnessLabel = (harnesses: readonly HarnessInfo[], id: string): string => harnesses.find((h) => h.id === id)?.label ?? id

function describeRef(config: PipelineConfig, ref: string, harnesses: readonly HarnessInfo[]): string {
  if (ref === AUTO_PROFILE) return 'Automatic'
  const profile = getProfile(config, ref)
  if (!profile) return 'Automatic'
  return [harnessLabel(harnesses, profile.harness), profile.model, profile.effort].filter(Boolean).join(' · ')
}

/** What the step runs on: `Automatic`, or the harness, model and effort, then the fallback. */
export function describePlan(config: PipelineConfig, step: TextStepId, harnesses: readonly HarnessInfo[]): string {
  const call = config.steps?.[step]?.passes?.[0]?.calls?.[0]
  if (!call) return 'Automatic'
  const main = describeRef(config, call.profile, harnesses)
  return call.onFail ? `${main}, then ${describeRef(config, call.onFail.profile, harnesses)}` : main
}

/** Where the text of the step goes: nowhere, the vendors, or wherever Settings > AI providers sends it. */
export function privacyLabel(config: PipelineConfig, step: TextStepId, harnesses: readonly HarnessInfo[]): string {
  const calls = (config.steps?.[step]?.passes ?? []).flatMap((p) => p.calls)
  if (calls.length === 0) return 'Follows AI providers'
  const refs = calls.flatMap((c) => [c.profile, ...(c.onFail ? [c.onFail.profile] : [])])
  const infos = refs.map((ref) => (ref === AUTO_PROFILE ? undefined : harnesses.find((h) => h.id === getProfile(config, ref)?.harness)))
  // Automatic, a missing profile and an unknown harness all mean the step runs where the providers page sends it.
  if (infos.some((info) => !info)) return 'Follows AI providers'
  const vendors: string[] = []
  for (const info of infos) {
    if (info?.dataLeavesMachine && !vendors.includes(info.vendor)) vendors.push(info.vendor)
  }
  if (vendors.length === 0) return 'Stays on this computer'
  if (vendors.length === 1) return `Sent to ${vendors[0]}`
  return `Sent to ${vendors.slice(0, -1).join(', ')} and ${vendors[vendors.length - 1]}`
}

const formatMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)
const formatCost = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`

/** The numbers beside a step: the median time and cost of the last 30 days, and how many calls failed. */
export function formatStats(stats: StepStats | undefined): string {
  if (!stats || stats.calls === 0) return 'No calls yet'
  const calls = `${stats.calls} ${stats.calls === 1 ? 'call' : 'calls'}`
  const failed = stats.failed > 0 ? ` · ${stats.failed} failed` : ''
  if (stats.medianMs === null) return `None completed · ${calls}${failed}`
  const cost = stats.medianCostUsd === null ? 'no cost recorded' : formatCost(stats.medianCostUsd)
  return `Median ${formatMs(stats.medianMs)} · ${cost} · ${calls}${failed}`
}

export function choiceFromProfile(profile: ProfileConfig): ChoiceFields {
  return { harness: profile.harness, model: profile.model ?? '', effort: profile.effort ?? '' }
}

function fieldsOfRef(config: PipelineConfig, ref: string): ChoiceFields {
  if (ref === AUTO_PROFILE) return AUTOMATIC
  const profile = getProfile(config, ref)
  return profile ? choiceFromProfile(profile) : AUTOMATIC
}

/** The editor's starting fields for a step: what is saved, or Automatic with no fallback. */
export function draftFromConfig(config: PipelineConfig, step: TextStepId): StepDraftFields {
  const call = config.steps?.[step]?.passes?.[0]?.calls?.[0]
  if (!call) return { primary: AUTOMATIC, fallback: NONE }
  return { primary: fieldsOfRef(config, call.profile), fallback: call.onFail ? fieldsOfRef(config, call.onFail.profile) : NONE }
}

/**
 * The choice the fields describe, as the main process takes it: `auto`, a profile draft, or null for no
 * choice. A model is left out for a harness that ignores it and an effort for one without levels.
 */
export function toStepChoice(fields: ChoiceFields, harnesses: readonly HarnessInfo[]): StepChoice | null {
  if (fields.harness === '') return null
  if (fields.harness === AUTO_PROFILE) return AUTO_PROFILE
  const info = harnesses.find((h) => h.id === fields.harness)
  const model = fields.model.trim()
  return {
    harness: fields.harness,
    ...(info?.modelSelectable && model ? { model } : {}),
    ...(fields.effort && info?.effortLevels?.includes(fields.effort) ? { effort: fields.effort } : {})
  }
}
