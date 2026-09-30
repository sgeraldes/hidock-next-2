/**
 * Provider-config resolution for the shared @hidock/ai-providers complete() seam.
 *
 * Extracted verbatim (spec-001 step 9) from the private providerConfigFromSettings()
 * that used to live in knowledge-graph-service.ts, so any caller that needs a
 * complete()-compatible ProviderConfig — the standalone value classifier
 * (value-classification.ts), knowledge-graph-service.ts's transcript ingestion,
 * and (later) T3's backfill runner — can resolve one without importing the
 * knowledge-graph module. Pure function of getConfig(); no side effects.
 */

import { getConfig } from './config'
import type { ProviderConfig } from '@hidock/ai-providers'
import { CURRENT_GEMINI_CHAT_MODEL } from './gemini-model-ids'
import { resolveGeminiApiKey } from './brains/gemini-api-brain'

/**
 * Resolve the AI provider config for the app's shared complete() seam, from
 * user Settings. Returns null when no usable provider is configured (no
 * Gemini API key, or chat.provider isn't 'gemini').
 */
export function getProviderConfigFromSettings(): ProviderConfig | null {
  const cfg = getConfig()

  // Use gemini if api key is set
  if (cfg.chat.provider === 'gemini' && cfg.transcription.geminiApiKey) {
    return {
      provider: 'google',
      model: cfg.chat.geminiModel || CURRENT_GEMINI_CHAT_MODEL,
      apiKey: cfg.transcription.geminiApiKey,
    }
  }

  // No valid provider configured
  return null
}

/**
 * The provider for the knowledge graph's transcript ingestion: the saved Gemini
 * key, whatever the chat provider is set to (owner decision, 30-sep-2026).
 *
 * The graph used to reuse `getProviderConfigFromSettings`, which needs
 * chat.provider to be 'gemini'. With chat on Ollama that returned null, and
 * every finished transcript logged "Auto-ingest skipped" while the graph
 * stayed empty, although the Gemini key was saved and transcription used it.
 * The key resolves through the credential store first, like transcription does.
 * Returns null only when there is no Gemini key at all.
 */
export function getGraphProviderConfig(): ProviderConfig | null {
  const apiKey = resolveGeminiApiKey()
  if (!apiKey) return null
  return {
    provider: 'google',
    model: getConfig().chat?.geminiModel || CURRENT_GEMINI_CHAT_MODEL,
    apiKey,
  }
}
