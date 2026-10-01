/**
 * The calls that reach a model without the router leave a ledger row too.
 *
 * Two of the six direct call sites (the standalone value rating and the graph extraction) call `complete()`
 * of `@hidock/ai-providers`, which returns only the text. The package reports what each completion cost to
 * one registered function; this module registers it, and the report goes to whichever call is being tracked
 * in that async context (`trackCall`), or nowhere when none is. No call site and no test mock of `complete`
 * has to change.
 */
import { setCompletionUsageReporter } from '@hidock/ai-providers'
import { recordHarnessUsage } from '../brains/harness-usage'

/** The package names its providers as the Vercel SDK does; the ledger names harnesses as the app does. */
const HARNESS_OF_PROVIDER: Record<string, string> = { google: 'gemini-api' }

export function registerCompletionUsage(): void {
  setCompletionUsageReporter((report) => {
    recordHarnessUsage({
      harness: HARNESS_OF_PROVIDER[report.provider] ?? report.provider,
      model: report.model,
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens,
      durationMs: report.durationMs
    })
  })
}
