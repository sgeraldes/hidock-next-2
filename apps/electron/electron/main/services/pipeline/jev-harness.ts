/**
 * Jev as a harness of the pipeline.
 *
 * Jev (TypeSafe System One) answers scored, chosen and yes-or-no questions about a state. It writes no
 * text, so it is not an AIBrain and the BrainRouter never sees it. This wrapper gives it what the other
 * harnesses have: a descriptor (fast, cheap, data leaves the machine), a check that it can run, and
 * usage reported to the harness collector. The tasks that map to Jev (evaluation, value, meeting match,
 * speaker names) call `ask` with their questions; a task that needs text cannot be pointed at it, and
 * the capability check of the catalog says so.
 */
import { askJev, JEV_MODEL, JevError, type AskJevOptions, type JevQuestion, type JevResponse, type JevStructured } from '../jev-client'
import { JEV_DESCRIPTOR } from '../brains/engine-descriptors'
import type { HarnessDescriptor } from '../brains/descriptor'
import { recordHarnessUsage } from '../brains/harness-usage'

export interface JevHarness {
  descriptor: HarnessDescriptor
  isConfigured(): boolean
  ask(state: JevStructured, questions: Record<string, JevQuestion>, opts?: AskJevOptions): Promise<JevResponse>
}

export function createJevHarness(deps: { getKey: () => string | null; askImpl?: typeof askJev }): JevHarness {
  const askImpl = deps.askImpl ?? askJev
  const key = (): string => (deps.getKey() ?? '').trim()
  return {
    descriptor: JEV_DESCRIPTOR,
    isConfigured: () => key().length > 0,
    async ask(state, questions, opts = {}) {
      const apiKey = key()
      if (!apiKey) throw new JevError('Jev API key is not set', null)
      const startedAt = Date.now()
      const response = await askImpl(apiKey, state, questions, opts)
      const usage = (response as { usage?: JevResponse['usage'] }).usage
      recordHarnessUsage({
        harness: 'jev',
        model: response.model || JEV_MODEL,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        durationMs: Date.now() - startedAt
      })
      return response
    }
  }
}
