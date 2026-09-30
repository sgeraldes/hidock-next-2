/**
 * AI Brains — public surface (H10, Phase 1).
 *
 * The provider-abstraction seam: an `AIBrain` interface, a capability-aware
 * `BrainRouter`, a `BrainRegistry`, per-brain credential storage, and the
 * Gemini-API + Ollama adapters that wrap the app's current LLM paths.
 */
export * from './types'
export * from './descriptor'
export { ENGINE_DESCRIPTORS, JEV_DESCRIPTOR } from './engine-descriptors'
export { listHarnessDescriptors, findHarness, harnessesWith } from './harness-catalog'
export { discoverModels, resetModelDiscoveryCache, STATIC_MODELS } from './model-discovery'
export { recordHarnessUsage, createHarnessUsageCollector, harnessRunFields } from './harness-usage'
export type {
  HarnessUsageReport,
  HarnessUsageTotal,
  HarnessUsageBucket,
  HarnessUsageCollector
} from './harness-usage'
export { BrainRouter, getBrainRouter, resetBrainRouter } from './brain-router'
export type { ChatFailure } from './brain-router'
export { BrainRegistry, getBrainRegistry, resetBrainRegistry } from './brain-registry'
export {
  BrainCredentialStore,
  getBrainCredentialStore,
  resetBrainCredentialStore,
} from './brain-credential-store'
export { GeminiApiBrain, resolveGeminiApiKey } from './gemini-api-brain'
export { OllamaBrain } from './ollama-brain'
export { LocalOnnxEmbedBrain } from './local-onnx-embed-brain'
export { ClaudeCodeBrain, resolveClaudeCommand } from './claude-code-brain'
export { CodexBrain } from './codex-brain'
export { GeminiCliBrain, parseGeminiJson } from './gemini-cli-brain'
export { KiroCliBrain, parseKiroOutput, parseKiroModels } from './kiro-cli-brain'
export { OpenAiCompatibleBrain, isLoopbackUrl } from './openai-compatible-brain'
export type { OpenAiCompatibleSettings } from './openai-compatible-brain'
export { runCli, foldMessagesToPrompt } from './cli-runner'
export type { SpawnFn, CliRunOptions, CliRunResult } from './cli-runner'
