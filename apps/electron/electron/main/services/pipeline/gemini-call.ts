/**
 * Reports one Gemini SDK response to the harness collector of the call being tracked.
 *
 * It lives here, apart from the Gemini brain, so the call sites that use the SDK directly (the timeline, the
 * transcript analysis, the image description) can report without importing the brain, which pulls in the
 * configuration and the Electron app. The Gemini stage collector of `gemini-usage.ts` keeps its own report:
 * call `recordGeminiUsage` as well where a processing run needs it.
 */
import { tokensFromUsage } from '../gemini-usage'
import { recordHarnessUsage } from '../brains/harness-usage'

export function reportGeminiCall(modelId: string, usage: unknown, startedAt: number): void {
  const tokens = tokensFromUsage(usage)
  recordHarnessUsage({
    harness: 'gemini-api',
    model: modelId,
    inputTokens: tokens?.promptTokens,
    outputTokens: tokens?.outputTokens,
    thinkingTokens: tokens?.thoughtsTokens,
    cachedTokens: tokens?.cachedTokens,
    durationMs: Date.now() - startedAt
  })
}
