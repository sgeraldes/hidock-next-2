import { generateText } from 'ai'
import { createProvider } from './provider-factory.js'
import type { ProviderConfig } from './types.js'

/** What one completion cost, as the package saw it. Tokens are absent when the provider did not report them. */
export interface CompletionUsageReport {
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  durationMs: number
}

let reporter: ((report: CompletionUsageReport) => void) | null = null

/**
 * Register the one function that hears about every completion (or remove it with null). The app uses it to
 * put the time and the tokens of a call in its ledger without changing any caller of `complete`. A reporter
 * that throws never changes what `complete` returns.
 */
export function setCompletionUsageReporter(fn: ((report: CompletionUsageReport) => void) | null): void {
  reporter = fn
}

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * Generate a text completion using the specified AI provider.
 * Uses createProvider() to build the language model, then calls generateText from the 'ai' SDK.
 * Returns the generated text string.
 */
export async function complete(prompt: string, config: ProviderConfig): Promise<string> {
  const { model } = createProvider(config)
  const startedAt = Date.now()
  const result = await generateText({ model, prompt })
  if (reporter) {
    try {
      reporter({
        provider: config.provider,
        model: config.model,
        inputTokens: count(result.usage?.inputTokens),
        outputTokens: count(result.usage?.outputTokens),
        durationMs: Date.now() - startedAt
      })
    } catch {
      /* a broken reporter must not change the completion */
    }
  }
  return result.text
}
