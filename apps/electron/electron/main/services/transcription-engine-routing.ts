/**
 * What each engine of the chain means for the audio route, and whether it can
 * run right now. Kept apart from transcription.ts so both are tested without
 * a recording, a network or a Model Host.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import type { ModelHostHealth } from './model-host-client'
import type { EngineStep } from './transcription-engine-chain'

/** The resolveAudioRoute inputs one chain step replaces. Null for `configured` and `requested` steps. */
export interface EngineRouteInput {
  provider: string
  /** Absent for cloud engines, which ignore it. */
  location?: 'local' | 'remote'
  remoteAsrModel?: string
}

export function engineRouteInput(step: EngineStep): EngineRouteInput | null {
  switch (step.provider) {
    case 'gemini':
      return { provider: 'gemini' }
    case 'remote':
      return { provider: 'remote-worker', location: 'remote', ...(step.model ? { remoteAsrModel: step.model } : {}) }
    case 'local':
      return { provider: step.model?.startsWith('microsoft/VibeVoice') ? 'vibevoice' : 'local-asr', location: 'local' }
    case 'configured':
    case 'requested':
      return null
  }
}

export interface AvailabilityDeps {
  hasGeminiKey(): boolean
  modelHost(): { url?: string; token?: string }
  checkHost(settings: { url: string; token: string }): Promise<ModelHostHealth | null>
  localAsrPath(): string | undefined
  fileExists?(path: string): boolean
}

/**
 * Null when the engine can be tried now, otherwise a sentence for the attempt
 * log. A host that is busy is still tried (its queue takes the job); a model
 * the host has not prepared is caught by the route's capability check and
 * moves the chain on the same way.
 */
export async function engineUnavailableReason(step: EngineStep, deps: AvailabilityDeps): Promise<string | null> {
  // The configured engine keeps its own checks (and its own local fallback setting).
  if (step.provider === 'requested' || step.provider === 'configured') return null
  if (step.provider === 'gemini') return deps.hasGeminiKey() ? null : 'Gemini API key not configured'
  if (step.provider === 'remote') {
    const { url, token } = deps.modelHost()
    if (!url?.trim() || !token) return 'No Model Host is paired'
    const health = await deps.checkHost({ url, token })
    if (!health) return 'The Model Host is not answering: paused, in use or off'
    if (health.state === 'paused' || health.state === 'stopped') {
      return `The Model Host is ${health.state}${health.reason ? `: ${health.reason}` : ''}`
    }
    return null
  }
  if (step.model?.startsWith('microsoft/VibeVoice')) return null
  const asrPath = deps.localAsrPath()
  if (!asrPath) return 'Local ASR path not configured'
  const runner = join(asrPath, 'mcp_runner.py')
  return (deps.fileExists ?? existsSync)(runner) ? null : `Local ASR runner not found: ${runner}`
}
