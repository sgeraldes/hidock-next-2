# Pipeline Phase 3a: Choose the Harness, Model and Effort of Each Text Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner pick, in Settings > Pipeline, the harness, model and effort that run each of the nine text steps that phase 2a put on the runner, with an optional fallback, a privacy badge and the measured time and cost per step, while a step left on Automatic keeps routing exactly as today.

**Architecture:** A `pipeline` section in the app configuration holds named profiles and one plan per step (the shape of design section 8, limited to one pass and one call with an optional fallback). A pure module shared by the main process and the page validates it and applies a step draft to it, so the page shows the verdict live and the main process refuses what the page would refuse. The runner's plan source (the seam of phase 2a) reads the section at call time, so a change applies at the next call with no restart; an invalid plan is ignored and the step runs as before. A `pipeline:*` IPC group serves the page: the state (steps, harnesses with availability, plans, statistics from the ledger), saving a step and listing the models of a harness. The page is new code in the redesigned Settings.

**Tech Stack:** TypeScript, Electron main and renderer, React with the app's `components/ui` kit, vitest (`node` for main, `jsdom` for the page), better-sqlite3 through the ledger of phase 2a.

**Spec:** `docs/superpowers/specs/2026-09-30-pipeline-design.md` (sections 7, 8, 10, 12 and 13, phase 3), plan 2a (`docs/superpowers/plans/2026-10-01-pipeline-phase-2a-runner.md`), whose runner, plan source and ledger this plan uses.

## Decisions made while the owner is away

The owner asked on 1-oct-2026 for the work to be finished without questions. These choices are recorded so the review can reverse any of them.

1. Automatic is the default and needs no data migration. A step with no entry runs on the router, which already follows Settings > AI providers and Decisions. The migration of the design (legacy keys to `pipeline`) matters when the old pages are retired, not before; building it now would add a second source of truth for nothing.
2. Phase 3 is split in two. 3a (this plan) is the configuration, the validation, the plan source, the IPC, the page and the OpenAI-compatible connection card. 3b is the Test bench with candidate results and Adopt (`pipeline_results`), the profile manager (create, rename, duplicate, delete) and presets: they need each step's input, parser and writer pulled out of its call site into a task definition, which is its own refactor.
3. Profiles are made by the page, not managed in it. Saving a step creates (or reuses) a profile named from its harness, model and effort, and removes profiles no step uses. This keeps the page to one editor per step.
4. The connection settings of the OpenAI-compatible server (address, model, embedding model, key) go on the AI providers page as a card, because the design keeps what is not a choice of model on each engine's own page (section 6, rule 5).
5. Only brains that can write text are offered: Jev, the audio engines and the embedding-only brain are not, and the page says why when a plan names one that cannot (a hand-edited file).

## Global Constraints

- With no `pipeline` configuration the app behaves as on 30-sep-2026 (spec section 1, item 6): every step is Automatic.
- An invalid plan is never run; the step falls back to Automatic and the page shows the reason (spec section 7, last rule).
- A named harness must be able to serve at call time (`BrainRouter.canServe`); the page offers only harnesses that are installed and signed in and greys out the rest with the reason (spec section 10).
- The page shows privacy on every step: whether the text leaves this computer and to which vendor, from `dataLeavesMachine` and `vendor` of the descriptor (spec section 6, rule 4).
- A slow harness (a CLI: 5 to 15 s a call) on a step that runs in bulk needs one confirmation when the plan is saved (spec section 6, rule 3).
- Nothing here needs a restart (spec section 10).
- Prompts never go in the log or in the page; the page shows steps, harnesses, models and numbers only.
- No secret goes in `pipeline`: keys stay in the credential store (`BrainCredentialStore`), as for every brain.
- Code style of the repository: no semicolons, single quotes, two-space indent, tests in a `__tests__` folder next to the code, `@vitest-environment node` on main-process tests, text files end with an empty line. Source files use CRLF line endings; a patch script reads and writes them in binary and keeps `\r\n`.
- UI work follows the app's existing pages (`features/settings/DecisionsSection.tsx`, `components/settings/AIBrainsSettings.tsx`) and the owner's design skills: dense, one line per fact, no decorative boxes, light and dark.
- The machine rules of the owner apply to every command: heavy commands one at a time and prefixed with `lowrun`; never redirect stderr; never open a window in the foreground (the page is checked in a hidden Electron window); never put a key or a token in a command or a test file.
- Commits carry no attribution lines. Stage explicit paths. Before every push run the secret gate and expect no output.

## Review Focus

1. A plan that names a profile that was deleted by hand, a harness that no longer exists, a model on a harness that ignores it, or an effort the harness does not take must not run, must not crash the call and must say why. Tasks 1 and 3.
2. A fallback must never be the same profile as the primary, and an ineligible source must still reach no fallback (the runner's rule; the configuration must not be able to bypass it). Tasks 1 and 3.
3. Saving from the page while another save is in flight, or saving a step whose profile another step uses, must not delete a profile that is still in use. Task 2.
4. A harness that is down, out of quota or not signed in must show as unavailable with the reason, and a step set to it must fall back or fail with a message that names the harness, not return nothing silently. Tasks 4 and 5.
5. The page must work with no ledger rows (new install) and with a ledger that cannot be read. Tasks 4 and 6.

## File Structure

New files:

| File | Responsibility |
|---|---|
| `apps/electron/src/shared/pipeline-config.ts` | Types, step metadata, `validatePipelineConfig`, `applyStepDraft`, `profileIdFor`. Pure; imported by both programs |
| `electron/main/services/pipeline/harness-info.ts` | Turns the harness descriptors into the `HarnessInfo` the validation and the page use |
| `electron/main/services/pipeline/config-plans.ts` | `createConfigPlanSource`: the configuration as the runner's plan source |
| `electron/main/services/pipeline/call-stats.ts` | Median time and cost per step from the ledger |
| `electron/main/ipc/pipeline-handlers.ts` | The `pipeline:*` channels |
| `src/features/settings/PipelineSection.tsx` and `src/features/settings/pipeline/*` | The page, the step row and the step editor |

Modified: `electron/main/services/config.ts` (the section and its default), `electron/main/services/pipeline/steps.ts` (`TEXT_STEPS` comes from the shared module), `electron/main/services/pipeline/call-store.ts` (the statistics query), `electron/main/index.ts` (install the plan source; the headless brain host runs no text step and installs neither the ledger nor the plan source), `electron/main/ipc/handlers.ts` and `brains-handlers.ts`, `electron/preload/index.ts`, `src/features/settings/sections.ts`, `src/pages/Settings.tsx`, `src/components/settings/AIBrainsSettings.tsx`, and the tests named in each task.

Run main tests from `apps/electron` with `lowrun npx vitest run <path>`; page tests the same way (the `renderer` project picks `src/**`).

---

### Task 1: The shared configuration module

**Files:**
- Create: `apps/electron/src/shared/pipeline-config.ts`
- Create: `apps/electron/src/shared/__tests__/pipeline-config.test.ts`
- Modify: `apps/electron/electron/main/services/pipeline/steps.ts` (take `TEXT_STEPS` from the shared module)

**Interfaces:**
- Produces (all exported from `pipeline-config.ts`):
  - `TEXT_STEP_IDS`, `type TextStepId`; `STEP_META: Record<TextStepId, { label: string; group: 'Interactive' | 'Speakers' | 'Library'; description: string; bulk: boolean }>`
  - `EFFORT_LEVELS`, `type EffortLevel`; `AUTO_PROFILE = 'auto'`
  - `interface ProfileConfig { harness: string; model?: string; effort?: EffortLevel; temperature?: number; maxTokens?: number }`
  - `interface PlanCallConfig { profile: string; tasks: '*'; role: 'produce'; onFail?: { profile: string } }`, `interface StepConfig { passes: Array<{ calls: PlanCallConfig[] }> }`
  - `interface PipelineConfig { version: 1; profiles: Record<string, ProfileConfig>; steps: Partial<Record<TextStepId, StepConfig>> }`, `emptyPipelineConfig(): PipelineConfig`
  - `interface HarnessInfo { id: string; label: string; vendor: string; kind: 'api' | 'local' | 'cli' | 'special' | 'engine'; textCapable: boolean; modelSelectable: boolean; effortLevels: readonly EffortLevel[] | null; dataLeavesMachine: boolean; latency: 'fast' | 'medium' | 'slow' | 'heavy' }`
  - `interface ValidationIssue { severity: 'error' | 'warning'; message: string; step?: TextStepId; profile?: string }`
  - `validatePipelineConfig(config: PipelineConfig, harnesses: readonly HarnessInfo[]): ValidationIssue[]`
  - `type ProfileDraft = Omit<ProfileConfig, never>` (same shape), `type StepChoice = ProfileDraft | typeof AUTO_PROFILE`
  - `profileIdFor(draft: ProfileDraft): string`
  - `applyStepDraft(config: PipelineConfig, step: TextStepId, primary: StepChoice, fallback: StepChoice | null): PipelineConfig` (pure: returns a new config, creates or reuses profiles, drops profiles no step uses, removes the step entry when it is Automatic with no fallback)

- [ ] **Step 1: Write the failing test**

Create `apps/electron/src/shared/__tests__/pipeline-config.test.ts`:

```ts
/**
 * The owner's pipeline choices: what is valid, and how a step draft becomes configuration.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  AUTO_PROFILE,
  applyStepDraft,
  emptyPipelineConfig,
  profileIdFor,
  validatePipelineConfig,
  type HarnessInfo,
  type PipelineConfig
} from '../pipeline-config'

const harness = (over: Partial<HarnessInfo> & { id: string }): HarnessInfo => ({
  label: over.id,
  vendor: 'v',
  kind: 'api',
  textCapable: true,
  modelSelectable: true,
  effortLevels: null,
  dataLeavesMachine: true,
  latency: 'fast',
  ...over
})

const HARNESSES: HarnessInfo[] = [
  harness({ id: 'gemini-api', vendor: 'Google' }),
  harness({ id: 'claude-code', vendor: 'Anthropic', kind: 'cli', latency: 'slow', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  harness({ id: 'ollama', vendor: 'local', kind: 'local', dataLeavesMachine: false, latency: 'medium' }),
  harness({ id: 'kiro', vendor: 'AWS', kind: 'cli', latency: 'slow', modelSelectable: false, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  harness({ id: 'jev', kind: 'special', textCapable: false }),
  harness({ id: 'local-onnx-embed', kind: 'local', textCapable: false })
]

const withStep = (profiles: PipelineConfig['profiles'], step: string, primary: string, onFail?: string): PipelineConfig =>
  ({
    version: 1,
    profiles,
    steps: { [step]: { passes: [{ calls: [{ profile: primary, tasks: '*', role: 'produce', ...(onFail ? { onFail: { profile: onFail } } : {}) }] }] } }
  }) as PipelineConfig

const errors = (c: PipelineConfig) => validatePipelineConfig(c, HARNESSES).filter((i) => i.severity === 'error')
const warnings = (c: PipelineConfig) => validatePipelineConfig(c, HARNESSES).filter((i) => i.severity === 'warning')

describe('validatePipelineConfig', () => {
  it('accepts the empty configuration and a plain single plan', () => {
    expect(validatePipelineConfig(emptyPipelineConfig(), HARNESSES)).toEqual([])
    expect(validatePipelineConfig(withStep({ g: { harness: 'gemini-api', model: 'gemini-3.8-flash' } }, 'notes', 'g'), HARNESSES)).toEqual([])
  })

  it('accepts Automatic as a profile, alone or as the primary of a fallback', () => {
    expect(errors(withStep({}, 'chat', AUTO_PROFILE))).toEqual([])
    expect(errors(withStep({ g: { harness: 'gemini-api' } }, 'chat', AUTO_PROFILE, 'g'))).toEqual([])
  })

  it('refuses a profile that does not exist, and names the step', () => {
    const [issue] = errors(withStep({}, 'notes', 'ghost'))
    expect(issue.message).toMatch(/ghost/)
    expect(issue.step).toBe('notes')
  })

  it('refuses a harness that does not exist or cannot write text', () => {
    expect(errors(withStep({ x: { harness: 'nope' } }, 'notes', 'x'))[0].message).toMatch(/nope/)
    expect(errors(withStep({ j: { harness: 'jev' } }, 'notes', 'j'))[0].message).toMatch(/cannot write text/)
    expect(errors(withStep({ e: { harness: 'local-onnx-embed' } }, 'notes', 'e'))[0].message).toMatch(/cannot write text/)
  })

  it('warns, without refusing, when the harness ignores the model or the effort', () => {
    const c = withStep({ k: { harness: 'kiro', model: 'x' }, g: { harness: 'gemini-api', effort: 'low' } }, 'notes', 'k', 'g')
    expect(errors(c)).toEqual([])
    expect(warnings(c).map((w) => w.message).join(' ')).toMatch(/ignores the model/)
    expect(warnings(c).map((w) => w.message).join(' ')).toMatch(/does not take an effort/)
  })

  it('refuses an effort the harness does not offer, and bad numbers', () => {
    expect(errors(withStep({ c: { harness: 'claude-code', effort: 'ultra' as never } }, 'notes', 'c'))[0].message).toMatch(/effort/)
    expect(errors(withStep({ c: { harness: 'ollama', temperature: 3 } }, 'notes', 'c'))[0].message).toMatch(/temperature/)
    expect(errors(withStep({ c: { harness: 'ollama', maxTokens: 0 } }, 'notes', 'c'))[0].message).toMatch(/limit/)
  })

  it('refuses a fallback that is the primary, and a fallback to a missing profile', () => {
    expect(errors(withStep({ g: { harness: 'gemini-api' } }, 'notes', 'g', 'g'))[0].message).toMatch(/same/)
    expect(errors(withStep({ g: { harness: 'gemini-api' } }, 'notes', 'g', 'ghost'))[0].message).toMatch(/ghost/)
  })

  it('refuses a step it does not know, more than one pass or call, and another version', () => {
    expect(errors({ version: 1, profiles: {}, steps: { nope: { passes: [] } } } as unknown as PipelineConfig)[0].message).toMatch(/nope/)
    const two = withStep({ g: { harness: 'gemini-api' } }, 'notes', 'g')
    two.steps.notes!.passes.push({ calls: [{ profile: 'g', tasks: '*', role: 'produce' }] })
    expect(errors(two)[0].message).toMatch(/one pass/)
    expect(errors({ version: 2, profiles: {}, steps: {} } as unknown as PipelineConfig)[0].message).toMatch(/version/)
  })

  it('warns that a CLI on a step that runs in bulk takes seconds per call, and not on an interactive one', () => {
    const profiles = { c: { harness: 'claude-code' } }
    expect(warnings(withStep(profiles, 'self-id', 'c')).map((w) => w.message).join(' ')).toMatch(/seconds/)
    expect(warnings(withStep(profiles, 'chat', 'c'))).toEqual([])
  })
})

describe('profileIdFor', () => {
  it('names a profile from its harness, model and effort, in a form that is safe as a key', () => {
    expect(profileIdFor({ harness: 'claude-code', model: 'haiku', effort: 'low' })).toBe('claude-code-haiku-low')
    expect(profileIdFor({ harness: 'ollama', model: 'qwen3:8b' })).toBe('ollama-qwen3-8b')
    expect(profileIdFor({ harness: 'gemini-api' })).toBe('gemini-api')
    expect(profileIdFor({ harness: 'ollama', model: 'Qwen 3 / 8B!!', temperature: 0.2 })).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('gives two profiles that differ only in temperature or limit different names', () => {
    const a = profileIdFor({ harness: 'ollama', model: 'm', temperature: 0.2 })
    const b = profileIdFor({ harness: 'ollama', model: 'm', temperature: 0.7 })
    expect(a).not.toBe(b)
  })
})

describe('applyStepDraft', () => {
  it('creates the profile of a draft and points the step at it', () => {
    const next = applyStepDraft(emptyPipelineConfig(), 'notes', { harness: 'claude-code', model: 'haiku', effort: 'low' }, null)
    expect(next.profiles['claude-code-haiku-low']).toEqual({ harness: 'claude-code', model: 'haiku', effort: 'low' })
    expect(next.steps.notes!.passes[0].calls[0]).toEqual({ profile: 'claude-code-haiku-low', tasks: '*', role: 'produce' })
  })

  it('adds a fallback, and keeps Automatic as the primary when asked', () => {
    const next = applyStepDraft(emptyPipelineConfig(), 'chat', AUTO_PROFILE, { harness: 'ollama', model: 'qwen3:8b' })
    expect(next.steps.chat!.passes[0].calls[0]).toEqual({ profile: AUTO_PROFILE, tasks: '*', role: 'produce', onFail: { profile: 'ollama-qwen3-8b' } })
  })

  it('removes the step entry when it is Automatic with no fallback, and the profiles nobody uses', () => {
    const set = applyStepDraft(emptyPipelineConfig(), 'notes', { harness: 'ollama', model: 'm' }, null)
    const reset = applyStepDraft(set, 'notes', AUTO_PROFILE, null)
    expect(reset.steps.notes).toBeUndefined()
    expect(reset.profiles).toEqual({})
  })

  it('reuses one profile for two steps and keeps it while either uses it', () => {
    const draft = { harness: 'ollama', model: 'm' }
    let c = applyStepDraft(emptyPipelineConfig(), 'notes', draft, null)
    c = applyStepDraft(c, 'reformat', draft, null)
    expect(Object.keys(c.profiles)).toEqual(['ollama-m'])
    c = applyStepDraft(c, 'notes', AUTO_PROFILE, null)
    expect(c.profiles['ollama-m']).toBeDefined()
    c = applyStepDraft(c, 'reformat', AUTO_PROFILE, null)
    expect(c.profiles).toEqual({})
  })

  it('does not change its input', () => {
    const base = emptyPipelineConfig()
    applyStepDraft(base, 'notes', { harness: 'ollama' }, null)
    expect(base).toEqual(emptyPipelineConfig())
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run src/shared/__tests__/pipeline-config.test.ts`
Expected: FAIL, "Failed to resolve import '../pipeline-config'".

- [ ] **Step 3: Write `pipeline-config.ts`**

Create `apps/electron/src/shared/pipeline-config.ts`:

```ts
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
  step?: TextStepId
  profile?: string
}

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function validatePipelineConfig(config: PipelineConfig, harnesses: readonly HarnessInfo[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const error = (message: string, where: { step?: TextStepId; profile?: string } = {}) => issues.push({ severity: 'error', message, ...where })
  const warn = (message: string, where: { step?: TextStepId; profile?: string } = {}) => issues.push({ severity: 'warning', message, ...where })
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
      error(`"${stepId}" is not a step.`)
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
        if (h && h.latency === 'slow') warn(`${h.label} takes seconds per call and ${STEP_META[at.step].label} runs once per recording.`, at)
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
```

In `electron/main/services/pipeline/steps.ts` replace the local `TEXT_STEPS` array with `export { TEXT_STEP_IDS as TEXT_STEPS } from '../../../../src/shared/pipeline-config'` and `import type { TextStepId } from '../../../../src/shared/pipeline-config'` plus `export type { TextStepId }`, keeping `OBSERVED_STEPS`, `StepId` and everything else as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run src/shared/__tests__/pipeline-config.test.ts electron/main/services/pipeline`
Expected: PASS. If the `profileIdFor` test for `'Qwen 3 / 8B!!'` fails on the regex, the slug is wrong: fix `slug`, not the test.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck` (both programs; expect no errors), then:

```bash
git add apps/electron/src/shared/pipeline-config.ts apps/electron/src/shared/__tests__/pipeline-config.test.ts apps/electron/electron/main/services/pipeline/steps.ts
git commit -m "Pipeline: the shared configuration module, with validation and step drafts"
```

---

### Task 2: The configuration section

**Files:**
- Modify: `apps/electron/electron/main/services/config.ts` (the `pipeline` section of `AppConfig` and `DEFAULT_CONFIG`)
- Create: `apps/electron/electron/main/services/__tests__/config-pipeline-default.test.ts`

**Interfaces:**
- Consumes: `PipelineConfig`, `emptyPipelineConfig` (Task 1).
- Produces: `AppConfig.pipeline: PipelineConfig`, default `emptyPipelineConfig()`.

- [ ] **Step 1: Write the failing test**

Create `electron/main/services/__tests__/config-pipeline-default.test.ts` by copying the setup of `config-features-default.test.ts` (the `electron` mock with a per-process userData directory, the credential store mock and `afterAll`), changing the directory name to `hidock-config-pipeline-test-${process.pid}`, then:

```ts
import { getConfig, updateConfig } from '../config'
import { emptyPipelineConfig, type PipelineConfig } from '../../../../src/shared/pipeline-config'

describe('config.pipeline', () => {
  it('is empty by default, so every step is Automatic', () => {
    expect(getConfig().pipeline).toEqual(emptyPipelineConfig())
  })

  it('keeps a saved plan, and drops it when the section is saved again without it', async () => {
    const withStep: PipelineConfig = {
      version: 1,
      profiles: { 'ollama-qwen3-8b': { harness: 'ollama', model: 'qwen3:8b' } },
      steps: { notes: { passes: [{ calls: [{ profile: 'ollama-qwen3-8b', tasks: '*', role: 'produce' }] }] } }
    }
    await updateConfig('pipeline', withStep)
    expect(getConfig().pipeline).toEqual(withStep)
    await updateConfig('pipeline', emptyPipelineConfig())
    expect(getConfig().pipeline).toEqual(emptyPipelineConfig())
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/__tests__/config-pipeline-default.test.ts`
Expected: FAIL (`getConfig().pipeline` is undefined, and `updateConfig('pipeline', ...)` does not typecheck).

- [ ] **Step 3: Add the section**

In `config.ts` add `import { emptyPipelineConfig, type PipelineConfig } from '../../../src/shared/pipeline-config'` next to the other `src/shared` import. In `interface AppConfig`, after `features: FeaturesConfig`:

```ts
  /**
   * The owner's pipeline choices: which harness, model and effort run each text step (design section 8).
   * Empty means every step is Automatic: the router follows Settings > AI providers, as before. Holds no
   * secret; keys stay in the credential store.
   */
  pipeline: PipelineConfig
```

and in `DEFAULT_CONFIG`, after `features: { ...DEFAULT_FEATURES_CONFIG },`:

```ts
  pipeline: emptyPipelineConfig(),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/services/__tests__/config-pipeline-default.test.ts electron/main/services/__tests__/config-interface.test.ts electron/main/services/__tests__/config-brains-migration.test.ts`
Expected: PASS. If `config-interface.test.ts` lists the sections of the config and fails on the new one, add `pipeline` to its expectation: that test exists to notice a new section.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/config.ts apps/electron/electron/main/services/__tests__
git commit -m "Pipeline: a pipeline section in the configuration, empty by default"
```

---

### Task 3: The configuration becomes the runner's plan source

**Files:**
- Create: `apps/electron/electron/main/services/pipeline/harness-info.ts`
- Create: `apps/electron/electron/main/services/pipeline/config-plans.ts`
- Create: `apps/electron/electron/main/services/pipeline/install.ts`
- Create: `apps/electron/electron/main/services/pipeline/__tests__/harness-info.test.ts`, `config-plans.test.ts`, `install.test.ts`
- Modify: `apps/electron/electron/main/index.ts`

**Interfaces:**
- Consumes: `listHarnessDescriptors`, `HarnessDescriptor` from `../brains` (phase 1); `setPlanSource`, `PlanSource` from `./plans`, `DEFAULT_PLANS`, `DirectProfile`, `Plan` from `./steps`, `installCallStore`, `CallDb` from `./call-store` (plan 2a); the shared module (Task 1).
- Produces:
  - `toHarnessInfo(d: HarnessDescriptor): HarnessInfo`, `listHarnessInfos(): HarnessInfo[]`
  - `createConfigPlanSource(deps: { getPipeline: () => PipelineConfig | undefined; getHarnesses: () => HarnessInfo[] }): PlanSource`
  - `installPipeline(db: CallDb): void` (installs the ledger and the plan source; both entry points call it)

- [ ] **Step 1: Write the failing tests**

Create `pipeline/__tests__/harness-info.test.ts`:

```ts
/**
 * The harness descriptors as the plain data the validation and the page use.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach, expectTypeOf } from 'vitest'
import type { BrainEffort } from '../../brains'
import type { EffortLevel } from '../../../../../src/shared/pipeline-config'

vi.mock('../../config', () => ({ getConfig: () => ({ brains: {} }) }))
vi.mock('../../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

import { resetBrainRegistry } from '../../brains'
import { listHarnessInfos } from '../harness-info'

afterEach(() => resetBrainRegistry())

describe('listHarnessInfos', () => {
  const byId = () => new Map(listHarnessInfos().map((h) => [h.id, h]))

  it('keeps the effort levels of the shared module the same as the brains', () => {
    expectTypeOf<BrainEffort>().toEqualTypeOf<EffortLevel>()
  })

  it('says which harnesses can write text: the brains that generate, not Jev, the audio engines or the embedding-only brain', () => {
    const h = byId()
    for (const id of ['gemini-api', 'ollama', 'openai-compatible', 'claude-code', 'codex', 'gemini-cli', 'kiro']) {
      expect(h.get(id)!.textCapable, id).toBe(true)
    }
    for (const id of ['jev', 'local-onnx-embed', 'vibevoice', 'local-asr', 'gemini-transcribe']) {
      expect(h.get(id)!.textCapable, id).toBe(false)
    }
  })

  it('carries the effort levels, the model rule, the privacy and the latency of each descriptor', () => {
    const h = byId()
    expect(h.get('claude-code')).toMatchObject({ effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], modelSelectable: true, dataLeavesMachine: true, latency: 'slow', vendor: 'Anthropic' })
    expect(h.get('gemini-api')!.effortLevels).toBeNull()
    expect(h.get('kiro')!.modelSelectable).toBe(false)
    expect(h.get('ollama')).toMatchObject({ dataLeavesMachine: false, kind: 'local' })
  })
})
```

Create `pipeline/__tests__/config-plans.test.ts`:

```ts
/**
 * The configuration as the runner's plan source: a valid plan is expanded, an invalid one is ignored
 * with a reason, and a step with no entry stays on today's routing.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AUTO_PROFILE, emptyPipelineConfig, type HarnessInfo, type PipelineConfig } from '../../../../../src/shared/pipeline-config'
import { createConfigPlanSource } from '../config-plans'
import { DEFAULT_PLANS } from '../steps'

const h = (over: Partial<HarnessInfo> & { id: string }): HarnessInfo => ({
  label: over.id, vendor: 'v', kind: 'api', textCapable: true, modelSelectable: true, effortLevels: null,
  dataLeavesMachine: true, latency: 'fast', ...over
})
const HARNESSES = [
  h({ id: 'gemini-api' }),
  h({ id: 'claude-code', kind: 'cli', latency: 'slow', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  h({ id: 'kiro', kind: 'cli', latency: 'slow', modelSelectable: false }),
  h({ id: 'jev', kind: 'special', textCapable: false })
]

const step = (profile: string, onFail?: string) => ({
  passes: [{ calls: [{ profile, tasks: '*' as const, role: 'produce' as const, ...(onFail ? { onFail: { profile: onFail } } : {}) }] }]
})

let pipeline: PipelineConfig | undefined
const source = () => createConfigPlanSource({ getPipeline: () => pipeline, getHarnesses: () => HARNESSES })

beforeEach(() => {
  pipeline = undefined
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('createConfigPlanSource', () => {
  it('has no plan when there is no pipeline section, or no entry for the step', () => {
    expect(source()('notes')).toBeNull()
    pipeline = emptyPipelineConfig()
    expect(source()('notes')).toBeNull()
  })

  it('expands a named profile into a direct profile with its model, effort, temperature and limit', () => {
    pipeline = {
      version: 1,
      profiles: { 'claude-code-haiku-low': { harness: 'claude-code', model: 'haiku', effort: 'low', temperature: 0, maxTokens: 300 } },
      steps: { notes: step('claude-code-haiku-low') }
    }
    expect(source()('notes')).toEqual({
      calls: [{ profile: { kind: 'direct', id: 'claude-code-haiku-low', harness: 'claude-code', model: 'haiku', effort: 'low', temperature: 0, maxTokens: 300 } }]
    })
  })

  it('keeps today\'s routing as the primary of an Automatic step with a fallback', () => {
    pipeline = { version: 1, profiles: { g: { harness: 'gemini-api' } }, steps: { chat: step(AUTO_PROFILE, 'g') } }
    expect(source()('chat')).toEqual({
      calls: [{ profile: DEFAULT_PLANS.chat.calls[0].profile, onFail: { kind: 'direct', id: 'g', harness: 'gemini-api' } }]
    })
  })

  it('leaves out the model of a harness that ignores it, because that harness would fail on one', () => {
    pipeline = { version: 1, profiles: { k: { harness: 'kiro', model: 'whatever' } }, steps: { notes: step('k') } }
    const plan = source()('notes')!
    expect(plan.calls[0].profile).toEqual({ kind: 'direct', id: 'k', harness: 'kiro' })
  })

  it('ignores a plan that is invalid, says why once, and does not ignore the valid ones', () => {
    pipeline = {
      version: 1,
      profiles: { j: { harness: 'jev' }, g: { harness: 'gemini-api' } },
      steps: { notes: step('j'), reformat: step('g'), chat: step('ghost') }
    }
    const plans = source()
    expect(plans('notes')).toBeNull() // Jev cannot write text
    expect(plans('chat')).toBeNull() // the profile does not exist
    expect(plans('reformat')).not.toBeNull()
    plans('notes')
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('does not ignore a plan for a warning', () => {
    pipeline = { version: 1, profiles: { c: { harness: 'claude-code' } }, steps: { 'self-id': step('c') } } // slow harness on a bulk step
    expect(source()('self-id')).not.toBeNull()
  })

  it('ignores every plan when the section has a version it does not read', () => {
    pipeline = { version: 2, profiles: {}, steps: { notes: step(AUTO_PROFILE) } } as unknown as PipelineConfig
    expect(source()('notes')).toBeNull()
  })

  it('reads the configuration at call time, so a change applies without a restart', () => {
    const plans = source()
    expect(plans('notes')).toBeNull()
    pipeline = { version: 1, profiles: { g: { harness: 'gemini-api' } }, steps: { notes: step('g') } }
    expect(plans('notes')).not.toBeNull()
  })
})
```

Create `pipeline/__tests__/install.test.ts`:

```ts
/**
 * installPipeline puts the ledger and the plan source in place, and both entry points call it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const config = vi.hoisted(() => ({ pipeline: undefined as unknown }))
vi.mock('../../config', () => ({ getConfig: () => ({ brains: {}, pipeline: config.pipeline }) }))
vi.mock('../../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

import { installPipeline } from '../install'
import { installCallStore, writeCall } from '../call-store'
import { resolvePlan, setPlanSource } from '../plans'
import { DEFAULT_PLANS } from '../steps'

afterEach(() => {
  installCallStore(null)
  setPlanSource(null)
  config.pipeline = undefined
})

describe('installPipeline', () => {
  it('sends calls to the database it was given', () => {
    const run = vi.fn()
    installPipeline({ run, queryAll: vi.fn(() => []) })
    writeCall({
      step: 'notes', recordingId: null, route: 'r', provider: null, model: null, status: 'completed',
      startedAt: 'a', completedAt: 'b', durationMs: 1, parentCallId: null, usage: null,
      estimatedCostAmount: null, estimatedCostCurrency: null, costMethod: null, errorMessage: null
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('makes the configuration the plan source: Automatic until the owner chooses', () => {
    installPipeline({ run: vi.fn(), queryAll: vi.fn(() => []) })
    expect(resolvePlan('notes')).toBe(DEFAULT_PLANS.notes)
    config.pipeline = {
      version: 1,
      profiles: { 'ollama-qwen3-8b': { harness: 'ollama', model: 'qwen3:8b' } },
      steps: { notes: { passes: [{ calls: [{ profile: 'ollama-qwen3-8b', tasks: '*', role: 'produce' }] }] } }
    }
    expect(resolvePlan('notes').calls[0].profile).toMatchObject({ kind: 'direct', harness: 'ollama', model: 'qwen3:8b' })
  })

  it('is called by the main process right after the database opens', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', '..', 'index.ts'), 'utf-8')
    expect(source).toMatch(/installPipeline\(\{ run, queryAll \}\)/)
    expect(source.indexOf('installPipeline(')).toBeGreaterThan(source.indexOf('initializeDatabase('))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/harness-info.test.ts electron/main/services/pipeline/__tests__/config-plans.test.ts electron/main/services/pipeline/__tests__/install.test.ts`
Expected: FAIL, "Failed to resolve import" for the three new modules.

- [ ] **Step 3: Write the modules**

In `pipeline-config.ts` (Task 1) make two small changes the plan source needs: add `code?: 'slow-bulk'` to `ValidationIssue`, set `code: 'slow-bulk'` on the bulk warning, and give the unknown-step error its scope, `error(`"${stepId}" is not a step.`, { step: stepId as TextStepId })`, so that it blocks no other step. Task 1's test already covers both messages.

Create `pipeline/harness-info.ts`:

```ts
/**
 * The harness descriptors as plain data for the shared validation and the Pipeline page.
 */
import { listHarnessDescriptors, type HarnessDescriptor } from '../brains'
import type { EffortLevel, HarnessInfo } from '../../../../src/shared/pipeline-config'

export function toHarnessInfo(d: HarnessDescriptor): HarnessInfo {
  return {
    id: d.id,
    label: d.label,
    vendor: d.vendor,
    kind: d.kind,
    textCapable: (d.kind === 'api' || d.kind === 'local' || d.kind === 'cli') && d.capabilities.has('text'),
    modelSelectable: d.modelSelectable,
    effortLevels: d.effort.kind === 'levels' ? ([...d.effort.levels] as EffortLevel[]) : null,
    dataLeavesMachine: d.dataLeavesMachine,
    latency: d.latency
  }
}

export function listHarnessInfos(): HarnessInfo[] {
  return listHarnessDescriptors().map(toHarnessInfo)
}
```

Create `pipeline/config-plans.ts`:

```ts
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
```

Create `pipeline/install.ts`:

```ts
/**
 * Put the pipeline in place once the database is open: the call ledger and the owner's plans.
 * The main process and the headless brain host call it, with `run` and `queryAll` of `database.ts`.
 */
import { getConfig } from '../config'
import { installCallStore, type CallDb } from './call-store'
import { createConfigPlanSource } from './config-plans'
import { listHarnessInfos } from './harness-info'
import { setPlanSource } from './plans'

export function installPipeline(db: CallDb): void {
  installCallStore(db)
  setPlanSource(createConfigPlanSource({ getPipeline: () => getConfig().pipeline, getHarnesses: listHarnessInfos }))
}
```

In `index.ts` replace the `installCallStore({ run, queryAll })` line of plan 2a (and its import) with `installPipeline({ run, queryAll })` and `import { installPipeline } from './services/pipeline/install'`. `brain-host.ts` stays as it is: it opens the database read-only and runs no text step.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/services/pipeline src/shared`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck` (expect no errors), then:

```bash
git add apps/electron/src/shared apps/electron/electron/main/services/pipeline apps/electron/electron/main/index.ts
git commit -m "Pipeline: the owner's configuration is the runner's plan source, ignored when invalid"
```

---

### Task 4: Time and cost of each step from the ledger

**Files:**
- Modify: `apps/electron/electron/main/services/pipeline/call-store.ts` (`getStepStats`)
- Modify: `apps/electron/electron/main/services/pipeline/__tests__/call-store.test.ts` (one `describe`)

**Interfaces:**
- Produces: `interface StepStats { calls: number; failed: number; medianMs: number | null; medianCostUsd: number | null }`, `getStepStats(sinceIso: string): Record<string, StepStats>` (throws when no database is installed, like the other readers).

- [ ] **Step 1: Write the failing tests**

In `call-store.test.ts` add `getStepStats` to the import from `../call-store` and append:

```ts
describe('getStepStats', () => {
  beforeEach(() => {
    runWithMassDeleteAllowed(() => run('DELETE FROM pipeline_calls'))
    installCallStore(db)
  })

  const at = (iso: string, over: Partial<CallRecord>): CallRecord =>
    record({ startedAt: iso, completedAt: iso, ...over })

  it('is empty without calls', () => {
    expect(getStepStats('2026-09-01T00:00:00.000Z')).toEqual({})
  })

  it('counts calls and failures and takes the median time and cost of the completed ones', () => {
    for (const [ms, cost] of [[1000, 0.001], [3000, 0.003], [2000, 0.002]] as const) {
      writeCall(at('2026-09-30T10:00:00.000Z', { step: 'notes', durationMs: ms, estimatedCostAmount: cost }))
    }
    writeCall(at('2026-09-30T11:00:00.000Z', { step: 'notes', status: 'failed', durationMs: 90000, estimatedCostAmount: null, errorMessage: 'empty answer' }))
    expect(getStepStats('2026-09-01T00:00:00.000Z').notes).toEqual({ calls: 4, failed: 1, medianMs: 2000, medianCostUsd: 0.002 })
  })

  it('takes the mean of the two middle values for an even count, and null cost when none is priced', () => {
    for (const ms of [1000, 2000, 3000, 4000]) {
      writeCall(at('2026-09-30T10:00:00.000Z', { step: 'chat', durationMs: ms, estimatedCostAmount: null, estimatedCostCurrency: null }))
    }
    expect(getStepStats('2026-09-01T00:00:00.000Z').chat).toMatchObject({ medianMs: 2500, medianCostUsd: null })
  })

  it('leaves out calls before the window and keeps the steps apart', () => {
    writeCall(at('2026-08-01T10:00:00.000Z', { step: 'notes' }))
    writeCall(at('2026-09-30T10:00:00.000Z', { step: 'reformat' }))
    const stats = getStepStats('2026-09-01T00:00:00.000Z')
    expect(Object.keys(stats)).toEqual(['reformat'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/call-store.test.ts`
Expected: FAIL, "getStepStats is not a function".

- [ ] **Step 3: Write `getStepStats`**

Append to `call-store.ts`:

```ts
export interface StepStats {
  calls: number
  failed: number
  /** Median duration of the completed calls; null when none completed. */
  medianMs: number | null
  /** Median estimated cost in US dollars of the completed calls that have one; null when none does. */
  medianCostUsd: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Per step: how many calls since `sinceIso`, how many did not complete, and the medians of the ones that did. */
export function getStepStats(sinceIso: string): Record<string, StepStats> {
  const rows = requireDb().queryAll<{ step: string; status: CallStatus; duration_ms: number; estimated_cost_amount: number | null }>(
    'SELECT step, status, duration_ms, estimated_cost_amount FROM pipeline_calls WHERE started_at >= ?',
    [sinceIso]
  )
  const grouped = new Map<string, typeof rows>()
  for (const row of rows) grouped.set(row.step, [...(grouped.get(row.step) ?? []), row])
  const out: Record<string, StepStats> = {}
  for (const [step, list] of grouped) {
    const completed = list.filter((r) => r.status === 'completed')
    out[step] = {
      calls: list.length,
      failed: list.length - completed.length,
      medianMs: median(completed.map((r) => r.duration_ms)),
      medianCostUsd: median(completed.flatMap((r) => (r.estimated_cost_amount === null ? [] : [r.estimated_cost_amount])))
    }
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/call-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/pipeline
git commit -m "Pipeline: the median time and cost of each step, read from the call ledger"
```

---

### Task 5: The `pipeline:*` channels

**Files:**
- Modify: `apps/electron/src/shared/pipeline-config.ts` (the state and request types the page and the main process share; `StepStats` moves here from `call-store.ts`)
- Create: `apps/electron/electron/main/ipc/pipeline-handlers.ts`
- Create: `apps/electron/electron/main/ipc/__tests__/pipeline-handlers.test.ts`
- Modify: `apps/electron/electron/main/ipc/handlers.ts` (register), `apps/electron/electron/preload/index.ts` (the `pipeline` group), `apps/electron/electron/main/services/pipeline/call-store.ts` (import `StepStats` from the shared module)

**Interfaces:**
- Consumes: Tasks 1 to 4; `getBrainRouter`, `getBrainRegistry`, `discoverModels`, `isBrainCoolingDown` from the brains (phase 1); `getConfig`, `updateConfig`.
- Produces (types in the shared module):
  - `interface HarnessState extends HarnessInfo { available: boolean; reason: string | null }`
  - `interface PipelineState { config: PipelineConfig; harnesses: HarnessState[]; stats: Record<string, StepStats> }`
  - `interface SaveStepArgs { step: TextStepId; primary: StepChoice; fallback: StepChoice | null; confirmSlow?: boolean }`
  - `interface SaveStepResult { success: boolean; issues?: ValidationIssue[]; needsConfirmation?: boolean; error?: string }`
  - `interface ModelOption { id: string; label?: string; note?: string }`
  - Channels: `pipeline:getState` () to `PipelineState`; `pipeline:saveStep` (`SaveStepArgs`) to `SaveStepResult`; `pipeline:listModels` (`{ harness: string }`) to `ModelOption[]`.
  - Preload: `window.electronAPI.pipeline.{ getState, saveStep, listModels }`.

- [ ] **Step 1: Write the failing test**

Create `electron/main/ipc/__tests__/pipeline-handlers.test.ts`, following `brains-handlers.test.ts` for the `ipcMain` mock (collect `handle` registrations, call the handler by channel name) and its mocks of the config and the brains; the cases:

```ts
describe('registerPipelineHandlers', () => {
  it('registers exactly the three channels', () => {
    expect([...handlers.keys()].sort()).toEqual(['pipeline:getState', 'pipeline:listModels', 'pipeline:saveStep'])
  })
})

describe('pipeline:getState', () => {
  it('returns the configuration, the text-capable harnesses with their availability and reason, and the stats', async () => {
    // router.canServe: gemini-api true, ollama true, claude-code false (authStatus: not configured, detail 'Not signed in')
    const state = await call('pipeline:getState')
    expect(state.config).toEqual(emptyPipelineConfig())
    expect(state.harnesses.map((h) => h.id)).toContain('gemini-api')
    expect(state.harnesses.find((h) => h.id === 'claude-code')).toMatchObject({ available: false, reason: 'Not signed in' })
    expect(state.harnesses.find((h) => h.id === 'jev')).toBeUndefined() // not text-capable
    expect(state.stats).toEqual({ notes: { calls: 3, failed: 0, medianMs: 1500, medianCostUsd: null } })
  })

  it('says why a resting harness is unavailable, and why a configured one that is turned off is', async () => { /* cooldown: "Out of quota"; configured but canServe false: "Turned off in Settings > AI providers" */ })

  it('still answers, with no stats, when the ledger cannot be read', async () => { /* getStepStats throws */ })
})

describe('pipeline:saveStep', () => {
  it('saves a valid draft through updateConfig and returns success', async () => { /* updateConfig called with the candidate */ })
  it('refuses a draft with errors, saves nothing, and returns the issues', async () => { /* a harness that cannot write text */ })
  it('asks for confirmation once when a slow harness is chosen for a step that runs in bulk, and saves with confirmSlow', async () => {
    const first = await call('pipeline:saveStep', { step: 'self-id', primary: { harness: 'claude-code' }, fallback: null })
    expect(first).toMatchObject({ success: false, needsConfirmation: true })
    expect(updateConfig).not.toHaveBeenCalled()
    const second = await call('pipeline:saveStep', { step: 'self-id', primary: { harness: 'claude-code' }, fallback: null, confirmSlow: true })
    expect(second.success).toBe(true)
  })
  it('refuses a malformed request without throwing', async () => { /* step not in TEXT_STEP_IDS, primary a number, fallback an array */ })
  it('serialises two saves that arrive together, so the second starts from the first\'s result', async () => { /* two saves for two steps; the final config holds both */ })
  it('removes a step and its unused profile when the draft is Automatic with no fallback', async () => { /* */ })
})

describe('pipeline:listModels', () => {
  it('returns the models of a text-capable harness through the discovery cache', async () => { /* discoverModels mocked */ })
  it('returns nothing for a harness it does not know or that cannot write text', async () => { /* */ })
})
```

Write each `it` out in full in the file (the comments above name the arrange and assert of each); mock `../../services/pipeline/call-store` for `getStepStats`, `../../services/config` for `getConfig` and `updateConfig`, and `../../services/brains` for the router, the registry, `discoverModels` and `isBrainCoolingDown`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/ipc/__tests__/pipeline-handlers.test.ts`
Expected: FAIL, "Failed to resolve import '../pipeline-handlers'".

- [ ] **Step 3: Write the types, the handlers and the preload group**

Add the types of the Interfaces block to `pipeline-config.ts` and make `call-store.ts` import `StepStats` from it. Create `pipeline-handlers.ts`:

```ts
/**
 * IPC for the Settings > Pipeline page. Namespace: `pipeline:*`.
 *
 * `getState` is everything the page draws: the owner's configuration, the harnesses that can write text with
 * their availability and the reason when they have none, and the median time and cost of each step from the
 * ledger. `saveStep` applies a draft with the shared `applyStepDraft`, validates the result with the shared
 * `validatePipelineConfig` (the page ran the same function live), asks once for confirmation when a slow
 * harness is chosen for a step that runs in bulk, and saves through `updateConfig`. Saves are serialised so
 * two that arrive together cannot lose each other's profile. `listModels` goes through the discovery cache of
 * phase 1: it never throws and never waits more than a few seconds.
 */
import { ipcMain } from 'electron'
import { getConfig, updateConfig } from '../services/config'
import { discoverModels, getBrainRegistry, getBrainRouter } from '../services/brains'
import { isBrainCoolingDown } from '../services/brains/brain-cooldown'
import type { BrainId } from '../services/brains/types'
import { getStepStats } from '../services/pipeline/call-store'
import { listHarnessInfos } from '../services/pipeline/harness-info'
import {
  TEXT_STEP_IDS,
  applyStepDraft,
  emptyPipelineConfig,
  validatePipelineConfig,
  type HarnessInfo,
  type HarnessState,
  type ModelOption,
  type PipelineConfig,
  type PipelineState,
  type SaveStepArgs,
  type SaveStepResult,
  type StepChoice,
  type StepStats
} from '../../../src/shared/pipeline-config'

const STATS_WINDOW_DAYS = 30

async function unavailableReason(id: string): Promise<string> {
  if (isBrainCoolingDown(id as BrainId)) return 'Out of quota for now; it rests until the limit resets.'
  try {
    const status = await getBrainRegistry().get(id as BrainId)?.authStatus()
    if (status && !status.configured) return status.detail ?? 'Not set up.'
  } catch {
    return 'Its status could not be read.'
  }
  return 'Turned off in Settings > AI providers.'
}

async function harnessState(info: HarnessInfo): Promise<HarnessState> {
  const available = await getBrainRouter().canServe(info.id as BrainId, 'chat').catch(() => false)
  return { ...info, available, reason: available ? null : await unavailableReason(info.id) }
}

function readStats(): Record<string, StepStats> {
  try {
    return getStepStats(new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000).toISOString())
  } catch {
    return {}
  }
}

export async function buildState(): Promise<PipelineState> {
  const harnesses = await Promise.all(listHarnessInfos().filter((h) => h.textCapable).map(harnessState))
  return { config: getConfig().pipeline ?? emptyPipelineConfig(), harnesses, stats: readStats() }
}

const isChoice = (value: unknown): value is StepChoice =>
  value === 'auto' || (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { harness?: unknown }).harness === 'string')

function parseSaveArgs(args: unknown): SaveStepArgs | null {
  if (typeof args !== 'object' || args === null) return null
  const a = args as Record<string, unknown>
  if (!(TEXT_STEP_IDS as readonly string[]).includes(a.step as string)) return null
  if (!isChoice(a.primary)) return null
  if (a.fallback !== null && !isChoice(a.fallback)) return null
  return { step: a.step as SaveStepArgs['step'], primary: a.primary, fallback: a.fallback as StepChoice | null, confirmSlow: a.confirmSlow === true }
}

let queue: Promise<unknown> = Promise.resolve()

async function saveOne(args: SaveStepArgs): Promise<SaveStepResult> {
  const current: PipelineConfig = getConfig().pipeline ?? emptyPipelineConfig()
  const candidate = applyStepDraft(current, args.step, args.primary, args.fallback)
  const issues = validatePipelineConfig(candidate, listHarnessInfos())
  if (issues.some((i) => i.severity === 'error')) return { success: false, issues }
  if (!args.confirmSlow && issues.some((i) => i.code === 'slow-bulk' && i.step === args.step)) {
    return { success: false, needsConfirmation: true, issues }
  }
  await updateConfig('pipeline', candidate)
  return { success: true, issues }
}

export async function saveStep(raw: unknown): Promise<SaveStepResult> {
  const args = parseSaveArgs(raw)
  if (!args) return { success: false, error: 'The request is not a valid step choice.' }
  const run = queue.then(() => saveOne(args))
  queue = run.catch(() => undefined)
  try {
    return await run
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function listModels(harness: string): Promise<ModelOption[]> {
  const info = listHarnessInfos().find((h) => h.id === harness)
  const brain = info?.textCapable ? getBrainRegistry().get(harness as BrainId) : null
  return brain ? discoverModels(brain) : []
}

export function registerPipelineHandlers(): void {
  ipcMain.handle('pipeline:getState', () => buildState())
  ipcMain.handle('pipeline:saveStep', (_e, args: unknown) => saveStep(args))
  ipcMain.handle('pipeline:listModels', (_e, args: { harness?: unknown }) => listModels(typeof args?.harness === 'string' ? args.harness : ''))
}
```

In `handlers.ts` add `import { registerPipelineHandlers } from './pipeline-handlers'` and call `registerPipelineHandlers()` after `registerBrainsHandlers()`. In `preload/index.ts` add to the `ElectronAPI` interface, after the `brains` group, and to the implementation, after its `brains` object:

```ts
  // Pipeline (phase 3a) — the owner's choice of harness, model and effort per text step.
  pipeline: {
    getState: () => Promise<PipelineState>
    saveStep: (args: SaveStepArgs) => Promise<SaveStepResult>
    listModels: (args: { harness: string }) => Promise<ModelOption[]>
  }
```

```ts
  pipeline: {
    getState: () => callIPC('pipeline:getState'),
    saveStep: (args) => callIPC('pipeline:saveStep', args),
    listModels: (args) => callIPC('pipeline:listModels', args)
  },
```

with `import type { ModelOption, PipelineState, SaveStepArgs, SaveStepResult } from '../../src/shared/pipeline-config'` among the preload's type imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/ipc/__tests__/pipeline-handlers.test.ts electron/main/services/pipeline src/shared`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck` (expect no errors), then:

```bash
git add apps/electron/src/shared apps/electron/electron/main/ipc apps/electron/electron/preload/index.ts apps/electron/electron/main/services/pipeline
git commit -m "Pipeline: the channels of the Pipeline page: state, save a step, list models"
```

---

### Task 6: The OpenAI-compatible connection on the AI providers page

**Files:**
- Modify: `apps/electron/electron/main/ipc/brains-handlers.ts` (`brains:getOpenAiCompatible`, `brains:setOpenAiCompatible`), `apps/electron/electron/main/ipc/__tests__/brains-handlers.test.ts` (channel list and cases)
- Modify: `apps/electron/electron/preload/index.ts` (two members of the `brains` group)
- Modify: `apps/electron/src/components/settings/AIBrainsSettings.tsx` and `src/components/settings/__tests__/AIBrainsSettings.test.tsx`

**Interfaces:**
- Produces: `brains:getOpenAiCompatible` () to `{ baseUrl: string; model: string; embeddingModel: string; hasKey: boolean }`; `brains:setOpenAiCompatible` (`{ baseUrl: string; model: string; embeddingModel: string }`) to `{ success: boolean; error?: string }`. The optional key goes through the existing `brains:setCredential` (`id: 'openai-compatible'`, `field: 'apiKey'`).

- [ ] **Step 1: Write the failing tests**

In `brains-handlers.test.ts` add the two channels to the registered-channels assertion and these cases (using the file's mocks; extend its config mock with a `brains.openaiCompatible` object and its credential-store mock with `hasSecret`):

```ts
describe('brains:getOpenAiCompatible', () => {
  it('returns the saved connection with the defaults filled in, and whether a key is stored, never the key', async () => {
    expect(await call('brains:getOpenAiCompatible')).toEqual({ baseUrl: 'http://localhost:1234/v1', model: '', embeddingModel: '', hasKey: false })
  })
})

describe('brains:setOpenAiCompatible', () => {
  it('saves a valid connection into config.brains.openaiCompatible', async () => {
    const result = await call('brains:setOpenAiCompatible', { baseUrl: 'http://192.168.1.20:1234/v1', model: 'qwen3-8b', embeddingModel: 'nomic-embed' })
    expect(result).toEqual({ success: true })
    expect(updateConfig).toHaveBeenCalledWith('brains', expect.objectContaining({ openaiCompatible: { baseUrl: 'http://192.168.1.20:1234/v1', model: 'qwen3-8b', embeddingModel: 'nomic-embed' } }))
  })
  it('refuses an address that is not http or https, a model that is too long, and a malformed request', async () => {
    for (const bad of [{ baseUrl: 'file:///etc/passwd', model: '', embeddingModel: '' }, { baseUrl: 'localhost:1234', model: '', embeddingModel: '' }, { baseUrl: 'http://x/v1', model: 'm'.repeat(201), embeddingModel: '' }, null, 'x']) {
      expect(await call('brains:setOpenAiCompatible', bad)).toMatchObject({ success: false })
    }
    expect(updateConfig).not.toHaveBeenCalled()
  })
})
```

In `AIBrainsSettings.test.tsx` add a case: with the brain list holding an `openai-compatible` brain, the page shows a "Local server" card with the address, model and embedding model filled from `brains.getOpenAiCompatible`, saving sends `brains.setOpenAiCompatible` with the trimmed values and shows an error toast for a refusal, a key field that sends `brains.setCredential({ id: 'openai-compatible', field: 'apiKey', value })` and shows "Key saved" afterwards without ever showing the value, and no card when the list lacks that brain.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `lowrun npx vitest run electron/main/ipc/__tests__/brains-handlers.test.ts src/components/settings/__tests__/AIBrainsSettings.test.tsx`
Expected: FAIL (channels not registered, card absent).

- [ ] **Step 3: Implement**

In `brains-handlers.ts` add, inside `registerBrainsHandlers()`:

```ts
  ipcMain.handle('brains:getOpenAiCompatible', async () => {
    const saved = getConfig().brains?.openaiCompatible
    let hasKey = false
    try {
      hasKey = getBrainCredentialStore().hasSecret('openai-compatible', 'apiKey')
    } catch {
      hasKey = false
    }
    return { baseUrl: saved?.baseUrl ?? 'http://localhost:1234/v1', model: saved?.model ?? '', embeddingModel: saved?.embeddingModel ?? '', hasKey }
  })

  ipcMain.handle('brains:setOpenAiCompatible', async (_e, args: unknown) => {
    const a = args as { baseUrl?: unknown; model?: unknown; embeddingModel?: unknown } | null
    if (!a || typeof a !== 'object') return { success: false, error: 'The request is not a valid connection.' }
    const baseUrl = typeof a.baseUrl === 'string' ? a.baseUrl.trim() : ''
    const model = typeof a.model === 'string' ? a.model.trim() : ''
    const embeddingModel = typeof a.embeddingModel === 'string' ? a.embeddingModel.trim() : ''
    let valid = false
    try {
      const url = new URL(baseUrl)
      valid = url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      valid = false
    }
    if (!valid) return { success: false, error: 'The address must start with http:// or https://.' }
    if (model.length > 200 || embeddingModel.length > 200) return { success: false, error: 'A model name can have at most 200 characters.' }
    await updateConfig('brains', { ...getConfig().brains, openaiCompatible: { baseUrl, model, embeddingModel } })
    return { success: true }
  })
```

Check that `brains:setCredential` accepts `id: 'openai-compatible'` with `field: 'apiKey'`: read its handler; if it holds an allow-list of fields per brain, add the new pair there with a test, never a free-form field. Add `getOpenAiCompatible` and `setOpenAiCompatible` to the preload `brains` group and its type. In `AIBrainsSettings.tsx` add a `LocalServerCard` component rendered after the brain list when the list holds `openai-compatible`: three text inputs (address, model, embedding model, each with a one-line hint: "Include /v1", "Leave empty to use the model the server has loaded"), a password field for the optional key with a "Save key" button and a "Key saved" note, a Save button disabled until something changed, a toast on error, and after a successful save a refresh of the brain list so the status badge shows "N models available" or "not reachable". Follow the markup of `BrainRow` and `DecisionsSection` (`rounded-lg border border-border`, `text-sm`, `text-muted-foreground`); no new component library.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/ipc/__tests__/brains-handlers.test.ts src/components/settings/__tests__/AIBrainsSettings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck` (expect no errors), then:

```bash
git add apps/electron/electron/main/ipc apps/electron/electron/preload/index.ts apps/electron/src/components/settings
git commit -m "Pipeline: the connection of a local OpenAI-compatible server on the AI providers page"
```

---

### Task 7: The Pipeline page

**Files:**
- Create: `apps/electron/src/features/settings/PipelineSection.tsx`
- Create: `apps/electron/src/features/settings/pipeline/StepRow.tsx`, `StepEditor.tsx`, `describe.ts` (plain-language summaries and the privacy badge text)
- Create: `apps/electron/src/features/settings/__tests__/PipelineSection.test.tsx`, `pipeline/__tests__/describe.test.ts`
- Modify: `apps/electron/src/features/settings/sections.ts` (the section), `apps/electron/src/features/settings/__tests__/sections.test.ts`, `apps/electron/src/pages/Settings.tsx` (the render line)

**Interfaces:**
- Consumes: `window.electronAPI.pipeline` (Task 5), `validatePipelineConfig`, `applyStepDraft`, `STEP_META`, `AUTO_PROFILE` from `@shared/pipeline-config`.
- Produces: `PipelineSection` (no props); a Settings section `pipeline` in the Services group, label "Pipeline", description "Which harness, model and effort run each step, and what each one costs."

The page is written against the tests below and the patterns of `DecisionsSection.tsx` and `AIBrainsSettings.tsx`: `useEffect` loads the state, local state holds one open editor and its draft, saving calls `saveStep`, a toast reports what the main process refused. Load the owner's design skills (`design-essence`, `impeccable`) before writing the markup: one line per fact, the steps grouped under their group label, no tinted boxes, no icons that carry no meaning, light and dark.

What each row shows, in this order: the step label and its one-line description; the plan as text (`Automatic`, or `Claude Code · haiku · low`, then `, then Gemini (API key)` for a fallback); a privacy badge (`Stays on this computer`, or `Sent to Google`, or `Follows AI providers` for Automatic); the numbers of the last 30 days (`Median 2.1 s · $0.0003 · 12 calls` or `No calls yet`, plus `1 failed` when there is one); an Edit button. The open editor shows: a main choice (Automatic, or a harness select with every text-capable harness, the unavailable ones disabled with their reason beside them), a model combobox (free text with the models the harness lists as suggestions, hidden for a harness that ignores the model), an effort select (only for a harness that has levels, with "Default" first), a fallback select (None, Automatic, or any available harness with its own model and effort fields), the live issues from `validatePipelineConfig` on the draft (errors in the destructive colour and Save disabled, warnings plain), a confirmation checkbox "I understand each call takes seconds" that appears only for the slow-bulk warning, and Save, Cancel and "Use Automatic" buttons.

- [ ] **Step 1: Write the failing tests**

`pipeline/__tests__/describe.test.ts` (pure): `describePlan(stepConfig, profiles, harnesses)` returns `Automatic` for no entry, `Claude Code · haiku · low` for a named profile, and appends `, then Gemini (API key)` for a fallback; `privacyLabel(plan, harnesses)` returns `Follows AI providers` for Automatic, `Stays on this computer` when every harness in the plan is local, and `Sent to Google` or `Sent to Google and Anthropic` otherwise; `formatStats(stats)` returns `No calls yet` for undefined, `Median 2.1 s · $0.0003 · 12 calls`, `Median 850 ms · no cost recorded · 3 calls` and appends ` · 1 failed`.

`PipelineSection.test.tsx` (jsdom, with `window.electronAPI.pipeline` mocked as in `AIBrainsSettings.test.tsx` and a fixture state holding Gemini (available), Ollama (available), Claude Code (unavailable: "Not signed in") and Kiro (available, model not selectable), and stats for `notes`):

```ts
it('shows every step under its group, each on Automatic with its privacy badge and numbers', async () => { /* "Assistant chat" under Interactive; notes row shows "Median 2.1 s"; steps without stats show "No calls yet" */ })
it('opens the editor, offers the available harnesses, and greys out the unavailable one with its reason', async () => { /* Claude Code option disabled, "Not signed in" visible */ })
it('saves a main choice with its model and effort as a draft the main process understands', async () => {
  // choose Gemini for Note analysis, type a model, Save
  expect(saveStep).toHaveBeenCalledWith({ step: 'notes', primary: { harness: 'gemini-api', model: 'gemini-3.8-flash' }, fallback: null, confirmSlow: false })
})
it('shows the suggestions the harness lists for the model, and still takes free text', async () => { /* listModels called with the harness; datalist options; typing a name outside the list is kept */ })
it('hides the model for a harness that ignores it, and the effort for one that has no levels', async () => { /* Kiro: no model field; Gemini: no effort select */ })
it('saves a fallback, and refuses to save the same choice twice, with the message and Save disabled', async () => { /* fallback equal to main: "the fallback is the same as the main choice" */ })
it('asks for the confirmation of a slow harness on a step that runs in bulk, and sends confirmSlow when checked', async () => { /* Speaker introductions + a CLI harness */ })
it('"Use Automatic" sends the Automatic choice with no fallback', async () => { /* saveStep({ step, primary: 'auto', fallback: null, confirmSlow: false }) */ })
it('shows what the main process refused, and keeps the editor open', async () => { /* saveStep resolves { success: false, issues: [...] }; the issue text is visible */ })
it('says so, and offers Retry, when the state cannot be loaded', async () => { /* getState rejects */ })
it('works with a configuration that already holds a plan: the row reads the plan and the editor opens on it', async () => { /* config with notes -> ollama profile */ })
```

Write each `it` in full in the file (the comment names its arrange and assert). `sections.test.ts` gains the assertion that `pipeline` is in the Services group after `ai-providers` and has keywords `['harness', 'model', 'effort', 'fallback', 'claude', 'gemini', 'ollama', 'cost']`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `lowrun npx vitest run src/features/settings`
Expected: FAIL (modules missing, section absent).

- [ ] **Step 3: Write the page, the pure helpers and the wiring**

Write `describe.ts` first (it is pure, and its test goes green on its own), then `StepEditor.tsx` (props: `step`, `state`, `initial`, `onSave`, `onCancel`; it owns the draft, builds the candidate configuration with `applyStepDraft`, validates with `validatePipelineConfig` against `state.harnesses`, and loads suggestions with `listModels` when the harness changes), `StepRow.tsx` (the summary line and the Edit button) and `PipelineSection.tsx` (loading, error and Retry, the groups in the order Interactive, Speakers, Library, one open editor at a time, the toast on a refusal). In `sections.ts` add the `pipeline` id to `SettingsSectionId` and the entry (icon `Workflow` from `lucide-react`) after `ai-providers`; in `Settings.tsx` import `PipelineSection` and add `{section === 'pipeline' && <PipelineSection />}` beside the `decisions` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run src/features/settings src/components/settings`
Expected: PASS.

- [ ] **Step 5: Look at it, without taking the foreground**

Render the real page with test data in a hidden Electron window, as for the Library cards: a one-page `vite build` of a harness file that mounts `PipelineSection` with a stubbed `window.electronAPI.pipeline` (a state with every status the tests use), then `capturePage` at 1000 px and at 400 px, in light and in dark. Read the four captures: no clipped text, the unavailable harness readable, the editor not wider than its row, one line per fact. Fix what the captures show, then delete the harness files by their literal names.

- [ ] **Step 6: Typecheck, lint and commit**

Run: `lowrun npm run typecheck` and `lowrun npx eslint src/features/settings src/components/settings electron/main/ipc` (expect no output), then:

```bash
git add apps/electron/src/features/settings apps/electron/src/pages/Settings.tsx
git commit -m "Pipeline: the Settings > Pipeline page, a plan for each text step"
```

---

### Task 8: Verification, documents and delivery

Same as task 10 of plan 2a, with these differences.

- [ ] **Step 1: Documents.** The design status line names phase 3a; the phases table splits row 3 into 3a (this plan) and 3b (the Test bench with candidate results and Adopt, the profile manager, presets); section 10 gets one sentence: "The page of phase 3a edits one plan per text step; profiles are made by saving a step and removed when no step uses them." Add a paragraph to `apps/electron/CHANGELOG.md` under today's entry, in the owner's words: "Settings > Pipeline lets you choose which AI harness, model and thinking effort runs each step the assistant and the library take, with a fallback, and shows what each step has cost and how long it takes. Steps you leave alone behave as before. A local server that speaks the OpenAI protocol (LM Studio, llama.cpp, vLLM) is configured under AI providers."
- [ ] **Step 2: Run everything**, one command at a time, from `apps/electron`: `npm run typecheck`, `npx eslint electron src/features/settings src/components/settings`, `npx vitest run`.
- [ ] **Step 3: Secret gate, push, review by a separate agent** with this focus: the five lines of Review Focus; that `saveStep` cannot save a configuration the plan source would ignore (the same validation, one function), that the page and the main process agree on what is an error, that the page never shows a key, that a harness set by hand to one that cannot write text falls back to Automatic with a log line and not a failed call, and that `brains:setOpenAiCompatible` refuses every address the adapter should not call (file, ftp, scripts, a missing host).
- [ ] **Step 4: Pull request, CI, merge, cleanup**, as in plan 2a.

---

## What plan 3b covers

The Test bench: run a draft plan now on a chosen recording or note, see each call's output, time, tokens and cost next to the stored result, and keep it as a candidate (`pipeline_results`) or adopt it. It needs each step's input, prompt, parser and writer pulled out of its call site into a task definition (the catalog of design section 5), which is also what lets a plan be tried without writing. The same plan covers the profile manager (create, rename, duplicate, delete, test connection), the presets (Recommended, Local only, Cheapest, Best quality, Custom) and the steps of plan 2b once they are on the runner.

## Self-review

- Spec coverage: section 8 (configuration, versioned, validated), section 7 (single and fallback, validated on save and on load, an invalid plan never run), section 10 (page: steps in groups, plan as chips, privacy badge, median time and cost, row editor with harness availability, model combobox, effort, fallback, live validation, slow confirmation, nothing needs a restart), section 6 rules 3 and 4, section 12 (Automatic is the recommended default). Outside this plan on purpose: the Test bench, Adopt, `pipeline_results`, the profile manager, presets (3b), the migration (not needed while Automatic follows the legacy settings), the audio steps (phase 4).
- Placeholders: the page's markup is written against its tests and the app's existing pages, not pasted; every test case is named with its arrange and assert and the pure modules are given in full.
- Types: `StepChoice`, `ProfileDraft`, `PipelineConfig`, `ValidationIssue`, `HarnessInfo` (Task 1) are used by the plan source (Task 3), the handlers (Task 5) and the page (Task 7); `StepStats` is defined in the shared module in Task 5 and imported by `call-store.ts`; `PlanSource`, `DEFAULT_PLANS` and `DirectProfile` come from plan 2a.
