/**
 * The text runner (pipeline design, section 9, phase 2a).
 *
 * `runText` takes a step, resolves its plan and runs the plan's one call:
 *   - a `router` profile is today's routing, untouched: the BrainRouter picks the brain, walks its chain
 *     and applies its own gates (chat mode), or resolves one brain that is then called once (generate mode);
 *   - a `direct` profile names a harness, which must be able to serve; the profile's model, effort,
 *     temperature and limit win over the caller's, and the caller's fill the gaps.
 * If the call answers nothing, fails, or its harness is unavailable, the plan's `onFail` profile runs once.
 * Not after an abort, and not for an ineligible source.
 *
 * The eligibility gate (`options.shouldGenerate`) runs right before every attempt that reaches a
 * provider, the fallback included; false or a throw means the source is ineligible and nothing is sent.
 * Every attempt that calls a provider leaves one row in the ledger (see track-call.ts); an attempt that
 * never reached one (unavailable, ineligible) leaves none.
 *
 * The outcome is a value. The call sites translate it into what they did before: null for an empty
 * answer, the original error rethrown for `error`, their own messages for the rest.
 */
import {
  getBrainRegistry,
  getBrainRouter,
  type BrainMessage,
  type BrainRegistry,
  type BrainRouter,
  type GenerateOptions
} from '../brains'
import { eligibleToGenerate } from '../brains/eligibility'
import { resolvePlan } from './plans'
import type { DirectProfile, Plan, Profile, TextStepId } from './steps'
import { trackCall, type CallMeta, type Judge, type TrackedCall } from './track-call'

export interface TextRequest {
  step: TextStepId
  messages: BrainMessage[]
  /** What the call site needs: prompt, temperature, limit, signal, gate. A named harness's own settings win. */
  options?: GenerateOptions
  recordingId?: string | null
}

export type TextFailure = 'empty' | 'unavailable' | 'ineligible' | 'error'

export type TextOutcome =
  | { ok: true; text: string; provider: string | null; callId: string | null }
  | { ok: false; reason: TextFailure; error?: unknown; callId: string | null }

export interface RunnerDeps {
  router: Pick<BrainRouter, 'chat' | 'resolve' | 'canServe'>
  registry: Pick<BrainRegistry, 'get'>
  planFor: (step: TextStepId) => Plan
  track: typeof trackCall
}

/** null and '' are no answer; a string of spaces is an answer, as the call sites treat it today. */
const emptyAnswer: Judge<string | null> = (value) => (value == null || value === '' ? 'empty answer' : null)

const ineligible = (): TextOutcome => ({ ok: false, reason: 'ineligible', callId: null })
const unavailable = (): TextOutcome => ({ ok: false, reason: 'unavailable', callId: null })

function settle(tracked: TrackedCall<string | null>): TextOutcome {
  if (!tracked.ok) return { ok: false, reason: 'error', error: tracked.error, callId: tracked.callId }
  const text = tracked.value
  if (text == null || text === '') return { ok: false, reason: 'empty', callId: tracked.callId }
  return { ok: true, text, provider: tracked.provider, callId: tracked.callId }
}

function withProfile(options: GenerateOptions, profile: DirectProfile): GenerateOptions {
  return {
    ...options,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {})
  }
}

async function runOne(deps: RunnerDeps, profile: Profile, request: TextRequest, parentCallId: string | null): Promise<TextOutcome> {
  const options = request.options ?? {}
  const meta = (route: string): CallMeta => ({
    step: request.step,
    recordingId: request.recordingId ?? null,
    route,
    parentCallId
  })

  if (profile.kind === 'router') {
    if (profile.mode === 'chat') {
      return settle(
        await deps.track(meta(`router:${profile.task}:chat`), () => deps.router.chat(profile.task, request.messages, options), emptyAnswer)
      )
    }
    const brain = await deps.router.resolve(profile.task, 'generate')
    if (!brain) return unavailable()
    if (!eligibleToGenerate(options.shouldGenerate)) return ineligible()
    return settle(await deps.track(meta(`router:${profile.task}:generate`), () => brain.generate(request.messages, options), emptyAnswer))
  }

  if (!(await deps.router.canServe(profile.harness, 'chat'))) return unavailable()
  const brain = deps.registry.get(profile.harness)
  if (!brain) return unavailable()
  if (!eligibleToGenerate(options.shouldGenerate)) return ineligible()
  return settle(await deps.track(meta(`direct:${profile.id}`), () => brain.chat(request.messages, withProfile(options, profile)), emptyAnswer))
}

export function createTextRunner(deps: RunnerDeps): (request: TextRequest) => Promise<TextOutcome> {
  return async function runText(request) {
    const call = deps.planFor(request.step).calls[0]
    const first = await runOne(deps, call.profile, request, null)
    if (first.ok || !call.onFail) return first
    if (first.reason === 'ineligible' || request.options?.signal?.aborted) return first
    return runOne(deps, call.onFail, request, first.callId)
  }
}

/** The runner over the real router, registry and plans. Built per call so a test that mocks `../brains` is honoured. */
export function runText(request: TextRequest): Promise<TextOutcome> {
  return createTextRunner({
    router: getBrainRouter(),
    registry: { get: (id) => getBrainRegistry().get(id) },
    planFor: resolvePlan,
    track: trackCall
  })(request)
}
