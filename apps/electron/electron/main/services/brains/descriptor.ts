/**
 * What a model harness can do, described the same way for every kind of harness.
 *
 * The pipeline (spec 2026-09-30, sections 5 and 6) chooses a harness per step. It can only do that
 * if an API model, a local server, a CLI, Jev and an audio engine all answer the same questions:
 * what can you do, how fast, does my data leave this machine, how is your effort set, what do you
 * need before you can run. This module holds those words. It has no runtime dependency, so the
 * catalog and the tests can import it without pulling Electron or an SDK in.
 */

import type { AIBrain, BrainCapability, BrainEffort } from './types'

export type HarnessKind = 'api' | 'local' | 'cli' | 'special' | 'engine'

/** How long one call takes: fast 1-3 s, medium up to 10 s, slow 5-15 s and more (a CLI), heavy is audio work. */
export type LatencyClass = 'fast' | 'medium' | 'slow' | 'heavy'

export type HarnessCapability =
  | 'text'
  | 'json-schema' // the adapter passes a schema to the harness's native structured mode (none does yet: GenerateOptions has `json` only)
  | 'vision' // the adapter sends an image (none does yet: BrainMessage content is text)
  | 'audio'
  | 'timestamps'
  | 'diarization'
  | 'embedding'
  | 'streaming'
  | 'long-context'
  | 'agentic' // can work in a repository with tools
  | 'classification' // Jev's primitives: score, choice, yes or no

export type EffortControl =
  | { kind: 'none' }
  | { kind: 'levels'; levels: readonly BrainEffort[] }
  | { kind: 'thinking-budget' }

/** What must be true before the harness can run, shown next to it when it cannot. */
export type HarnessNeeds = 'api-key' | 'cli-login' | 'running-server' | 'model-files' | 'none'

export interface HarnessDescriptor {
  id: string
  label: string
  kind: HarnessKind
  vendor: string
  /** True unless the harness runs on this machine. The Local only preset refuses any that says true. */
  dataLeavesMachine: boolean
  latency: LatencyClass
  capabilities: ReadonlySet<HarnessCapability>
  effort: EffortControl
  needs: HarnessNeeds
  /** False when the harness ignores a model chosen by name (kiro-cli 2.24.1 answers "Method not found"). */
  modelSelectable: boolean
}

/** A model a harness offers, for the model combobox of the Pipeline page. */
export interface ModelInfo {
  id: string
  label?: string
  note?: string
}

export function caps(...list: HarnessCapability[]): ReadonlySet<HarnessCapability> {
  return new Set(list)
}

/** What each capability of the older brain interface means in these words. */
export const BRAIN_CAPABILITY_TO_HARNESS: Record<BrainCapability, HarnessCapability> = {
  generate: 'text',
  chat: 'text',
  analyzeAudio: 'audio',
  embed: 'embedding',
  agentic: 'agentic'
}

/** The capabilities in `required` that the harness lacks, in the order they were asked. */
export function missingCapabilities(
  descriptor: HarnessDescriptor,
  required: readonly HarnessCapability[]
): HarnessCapability[] {
  return required.filter((c) => !descriptor.capabilities.has(c))
}

/**
 * The descriptor of a brain. A brain that has none (a test fake, an adapter written before this
 * module) gets a cautious one derived from its capabilities: data leaves the machine, medium latency.
 */
export function describeBrain(brain: AIBrain): HarnessDescriptor {
  if (brain.descriptor) return brain.descriptor()
  const capabilities = new Set<HarnessCapability>()
  for (const c of brain.capabilities()) capabilities.add(BRAIN_CAPABILITY_TO_HARNESS[c])
  return {
    id: brain.id,
    label: brain.label,
    kind: 'api',
    vendor: 'unknown',
    dataLeavesMachine: true,
    latency: 'medium',
    capabilities,
    effort: { kind: 'none' },
    needs: 'none',
    modelSelectable: true
  }
}
