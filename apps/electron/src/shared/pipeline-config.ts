/**
 * The owner's choices for the pipeline: which harness, model and effort run each text step.
 *
 * Pure types and functions, no imports from the main process or the renderer, so the same code decides
 * in the main process whether a plan may run and in the Pipeline page whether a draft may be saved.
 * Phase 3a supports one pass with one call and an optional fallback (design section 7, "One shot" and
 * "Fallback"); the shape is the design's, so stacked and parallel plans need no new format.
 */

export const TEXT_STEP_IDS = [
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
export type TextStepId = (typeof TEXT_STEP_IDS)[number]

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** The step runs as it does today: the router follows Settings > AI providers. */
export const AUTO_PROFILE = 'auto'

export interface StepMeta {
  label: string
  group: 'Interactive' | 'Speakers' | 'Library'
  description: string
  /** Runs once per recording or per block in bulk jobs, so a slow harness costs minutes. */
  bulk: boolean
}

export const STEP_META: Record<TextStepId, StepMeta> = {
  chat: { label: 'Assistant chat', group: 'Interactive', description: 'Answers your questions about the library.', bulk: false },
  'rag-summarize': { label: 'Meeting summary', group: 'Interactive', description: 'Summarises a meeting when you ask the assistant.', bulk: false },
  'rag-action-items': { label: 'Action items', group: 'Interactive', description: 'Lists the action items the assistant finds.', bulk: false },
  outputs: { label: 'Documents', group: 'Interactive', description: 'Writes a document from a template and your meetings.', bulk: false },
  'self-id': { label: 'Speaker introductions', group: 'Speakers', description: 'Finds who introduces themselves in a transcript.', bulk: true },
  'speaker-roster': { label: 'Speaker names from the guest list', group: 'Speakers', description: 'Matches unnamed speakers to the people invited.', bulk: true },
  'meeting-pick': { label: 'Meeting pick', group: 'Library', description: 'Chooses one of several meetings that overlap a recording.', bulk: true },
  reformat: { label: 'Transcript reformat', group: 'Library', description: 'Turns an old flat transcript into speaker turns.', bulk: true },
  notes: { label: 'Note analysis', group: 'Library', description: 'Gives a note a title, a summary, a category and tags.', bulk: false }
}

export interface ProfileConfig {
  harness: string
  model?: string
  effort?: EffortLevel
  temperature?: number
  maxTokens?: number
}

export interface PlanCallConfig {
  /** A profile id, or `auto`. */
  profile: string
  tasks: '*'
  role: 'produce'
  onFail?: { profile: string }
}

export interface StepConfig {
  passes: Array<{ calls: PlanCallConfig[] }>
}

export interface PipelineConfig {
  version: 1
  profiles: Record<string, ProfileConfig>
  steps: Partial<Record<TextStepId, StepConfig>>
}

export function emptyPipelineConfig(): PipelineConfig {
  return { version: 1, profiles: {}, steps: {} }
}

/** What validation needs to know about a harness: a plain-data view of its descriptor. */
export interface HarnessInfo {
  id: string
  label: string
  vendor: string
  kind: 'api' | 'local' | 'cli' | 'special' | 'engine'
  textCapable: boolean
  modelSelectable: boolean
  /** null when the harness has no effort control. */
  effortLevels: readonly EffortLevel[] | null
  dataLeavesMachine: boolean
  latency: 'fast' | 'medium' | 'slow' | 'heavy'
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  message: string
  /** Names the kind of issue when the caller acts on it (the Pipeline page asks once for a slow harness on a bulk step). */
  code?: 'slow-bulk'
  step?: TextStepId
  profile?: string
}

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function validatePipelineConfig(config: PipelineConfig, harnesses: readonly HarnessInfo[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const error = (message: string, where: { step?: TextStepId; profile?: string } = {}) => issues.push({ severity: 'error', message, ...where })
  const warn = (message: string, where: { step?: TextStepId; profile?: string; code?: 'slow-bulk' } = {}) =>
    issues.push({ severity: 'warning', message, ...where })
  const byId = new Map(harnesses.map((h) => [h.id, h]))

  if (config.version !== 1) {
    error(`The pipeline settings are version ${String(config.version)}; this app reads version 1.`)
    return issues
  }

  for (const [id, profile] of Object.entries(config.profiles ?? {})) {
    const at = { profile: id }
    if (!PROFILE_ID.test(id) || id === AUTO_PROFILE) error(`"${id}" is not a usable profile name.`, at)
    const h = byId.get(profile.harness)
    if (!h) {
      error(`Profile "${id}" uses "${profile.harness}", which is not a known harness.`, at)
      continue
    }
    if (!h.textCapable) error(`Profile "${id}" uses ${h.label}, which cannot write text.`, at)
    if (profile.model && !h.modelSelectable) warn(`${h.label} ignores the model; it runs its own default.`, at)
    if (profile.effort !== undefined) {
      if (!h.effortLevels) warn(`${h.label} does not take an effort; it is ignored.`, at)
      else if (!h.effortLevels.includes(profile.effort)) error(`Profile "${id}": ${String(profile.effort)} is not an effort ${h.label} offers.`, at)
    }
    if (profile.temperature !== undefined && !(profile.temperature >= 0 && profile.temperature <= 2)) {
      error(`Profile "${id}": the temperature must be between 0 and 2.`, at)
    }
    if (profile.maxTokens !== undefined && !(Number.isInteger(profile.maxTokens) && profile.maxTokens >= 1 && profile.maxTokens <= 200000)) {
      error(`Profile "${id}": the output limit must be a whole number from 1 to 200000.`, at)
    }
  }

  const knownSteps = new Set<string>(TEXT_STEP_IDS)
  for (const [stepId, step] of Object.entries(config.steps ?? {})) {
    if (!knownSteps.has(stepId)) {
      error(`"${stepId}" is not a step.`, { step: stepId as TextStepId })
      continue
    }
    const at = { step: stepId as TextStepId }
    if (step.passes.length !== 1 || step.passes[0].calls.length !== 1) {
      error(`${STEP_META[at.step].label}: this version runs one pass with one call.`, at)
      continue
    }
    const call = step.passes[0].calls[0]
    const refs = [call.profile, ...(call.onFail ? [call.onFail.profile] : [])]
    for (const ref of refs) {
      if (ref !== AUTO_PROFILE && !config.profiles[ref]) error(`${STEP_META[at.step].label} uses "${ref}", which does not exist.`, at)
    }
    if (call.onFail && call.onFail.profile === call.profile) error(`${STEP_META[at.step].label}: the fallback is the same as the main choice.`, at)
    if (STEP_META[at.step].bulk) {
      for (const ref of refs) {
        const h = byId.get(config.profiles[ref]?.harness ?? '')
        if (h && h.latency === 'slow') {
          warn(`${h.label} takes seconds per call and ${STEP_META[at.step].label} runs once per recording.`, { ...at, code: 'slow-bulk' })
        }
      }
    }
  }
  return issues
}

export type ProfileDraft = ProfileConfig
export type StepChoice = ProfileDraft | typeof AUTO_PROFILE

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** A profile's id from what it is: harness, model, effort, and any temperature or limit. */
export function profileIdFor(draft: ProfileDraft): string {
  const parts = [draft.harness, draft.model ?? '', draft.effort ?? '', draft.temperature !== undefined ? `t${draft.temperature}` : '', draft.maxTokens !== undefined ? `m${draft.maxTokens}` : '']
  const id = parts.map(slug).filter(Boolean).join('-')
  return id.slice(0, 64).replace(/-+$/, '') || 'profile'
}

function profileOf(draft: ProfileDraft): ProfileConfig {
  return {
    harness: draft.harness,
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(draft.temperature !== undefined ? { temperature: draft.temperature } : {}),
    ...(draft.maxTokens !== undefined ? { maxTokens: draft.maxTokens } : {})
  }
}

/** Point a step at the choices of a draft. Pure: the input is not changed. */
export function applyStepDraft(config: PipelineConfig, step: TextStepId, primary: StepChoice, fallback: StepChoice | null): PipelineConfig {
  const profiles: Record<string, ProfileConfig> = { ...config.profiles }
  const steps: PipelineConfig['steps'] = { ...config.steps }
  const refOf = (choice: StepChoice): string => {
    if (choice === AUTO_PROFILE) return AUTO_PROFILE
    const id = profileIdFor(choice)
    profiles[id] = profileOf(choice)
    return id
  }
  if (primary === AUTO_PROFILE && fallback === null) {
    delete steps[step]
  } else {
    const profile = refOf(primary)
    const onFail = fallback === null ? undefined : { profile: refOf(fallback) }
    steps[step] = { passes: [{ calls: [{ profile, tasks: '*', role: 'produce', ...(onFail ? { onFail } : {}) }] }] }
  }
  const used = new Set<string>()
  for (const s of Object.values(steps)) {
    for (const call of s?.passes.flatMap((p) => p.calls) ?? []) {
      used.add(call.profile)
      if (call.onFail) used.add(call.onFail.profile)
    }
  }
  for (const id of Object.keys(profiles)) if (!used.has(id)) delete profiles[id]
  return { version: 1, profiles, steps }
}
