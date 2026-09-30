# Pipeline Phase 1: Harness Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every model harness of the app (API, local, CLI, Jev, audio and embedding engines) a capability descriptor, model discovery, usage and cost reporting and a structured-output contract, and add the OpenAI-compatible adapter, so the pipeline runner of phase 2 can choose among them.

**Architecture:** The seven adapters in `apps/electron/electron/main/services/brains/` stay the harness adapters. Each gains a `descriptor()` (what it can do, what it costs in latency and privacy, how its effort is set) and, where the harness can list models, `listModels()`. A new adapter, `openai-compatible`, covers LM Studio, llama.cpp server and vLLM. Usage reporting uses an `AsyncLocalStorage` collector like the existing Gemini one, so no signature changes. A new `pipeline/` folder holds what is not an adapter: the structured-output contract with JSON repair, and the Jev harness. Nothing visible changes for the owner.

**Tech Stack:** TypeScript, Electron main process, vitest (`@vitest-environment node`), zod 4 (already a dependency), `AsyncLocalStorage`, `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-30-pipeline-design.md` (sections 5, 6, 9 and 13, phase 1), `docs/superpowers/specs/2026-09-30-pipeline-design-inventory.md`.

## Global Constraints

- Phase 1 changes no visible behaviour and no default: with no configuration the app behaves as on 30-sep-2026 (spec section 1, item 6; section 13, phase 1 "none visible").
- A harness is always run stripped down; a run for an agent that works in a repository is the only exception and says so with `agentic: true` (spec section 6).
- Prompts never go in argv and never in the log; only constants do. Failures are logged through `summarizeCliFailure`. Secrets stay in the credential store (`BrainCredentialStore`), never in `config.json` (spec section 6, rule 5).
- A harness that is out of quota rests until its reset (`brain-cooldown`); adapters keep calling `noteBrainFailure` (spec section 6, rule 6).
- Structured output is a contract: a JSON schema per task, the native mode where the adapter has one, otherwise the schema in the prompt, a lenient parser, and one repair call by a cheap profile (spec section 6, rule 2).
- Privacy is a property of the harness: `dataLeavesMachine` is on every descriptor (spec section 6, rule 4).
- Every AI call is recorded with usage and cost where the harness reports them, and with its duration where it does not (spec section 9, step 8).
- Code style of the repository: no semicolons, single quotes, two-space indent, tests in a `__tests__` folder next to the code, `@vitest-environment node` on main-process tests, text files end with an empty line.
- The machine rules of the owner apply to every command in this plan: run heavy commands (`npm ci`, the full test suite, builds) one at a time and prefixed with `lowrun`; never redirect stderr (no `2>&1`, `2>`, `2>/dev/null`), redirect stdout to a file when the output is long; never open a window; never put a key or a token in a command or in a test file.
- Commits carry no attribution lines. Stage explicit paths, never `git add -A`. Before every push run the secret gate: `git grep -Il -e . -- . | grep -v '^.secrets.baseline$' | xargs -n 100 python -m detect_secrets.pre_commit_hook --baseline .secrets.baseline` and expect no output.

## Review Focus

Inputs and conditions the spec implies and no task's happy path exercises. Each line has its test in the task named after it.

1. A brain with no `descriptor()` (a test fake, a future adapter) must not break the catalog: `describeBrain` derives one from its capabilities. Task 1.
2. An OpenAI-compatible server that is down, answers with a non-JSON or partial body, or returns fewer embeddings than texts: `generate` returns null, `embed` returns one entry per text, nothing throws into the router. Task 3.
3. Model discovery must never hang or throw: every list call has a timeout, a failing source returns the last good list (or `[]`), and a slow source is asked once for concurrent callers. Task 5.
4. Usage reported outside any collector is dropped, and inside nested collectors goes to the innermost one only, so a runner that opens one per call does not double count. Task 6.
5. Claude Code prints plain text on an older version, or a JSON array of events on the current one; both must yield the same answer text, and a JSON run that reports an error must be a failure, not an answer. Task 7.
6. JSON that a model wraps in prose or a code fence, closes with the wrong bracket, leaves truncated, or fills with unescaped quotes: the contract returns a typed failure that names the reason, never a half-filled object, and asks for a repair at most once. Task 8.

## File Structure

New files (all under `apps/electron/electron/main/services/`):

| File | Responsibility |
|---|---|
| `brains/descriptor.ts` | `HarnessDescriptor` and its vocabulary, `describeBrain`, `missingCapabilities`, `ModelInfo` |
| `brains/openai-compatible-brain.ts` | Adapter for any server that speaks the OpenAI REST protocol |
| `brains/engine-descriptors.ts` | Descriptors of the engines that are not brains: transcription, diarization, live |
| `brains/harness-catalog.ts` | `listHarnessDescriptors()`: brains plus engines, one list |
| `brains/model-discovery.ts` | `discoverModels(brain)` with a cache, timeouts and static lists |
| `brains/harness-usage.ts` | Usage collector, `recordHarnessUsage`, `harnessRunFields` |
| `pipeline/json-repair.ts` | `repairJsonString`, moved out of `transcription.ts` (pure) |
| `pipeline/structured-output.ts` | `defineContract`, `parseWithContract`, `runContract` (parse, repair once, fail typed) |
| `pipeline/jev-harness.ts` | Jev behind a descriptor and an `ask()` that reports usage |

Modified: `brains/types.ts`, `brains/index.ts`, `brains/brain-registry.ts`, the seven existing adapters, `config.ts`, `electron/preload/index.ts`, `transcription.ts` (re-export only), and the tests named in each task.

Run tests from `apps/electron` with `lowrun npx vitest run <path>`.

---

### Task 1: The descriptor vocabulary

**Files:**
- Create: `apps/electron/electron/main/services/brains/descriptor.ts`
- Create: `apps/electron/electron/main/services/brains/__tests__/descriptor.test.ts`
- Modify: `apps/electron/electron/main/services/brains/types.ts` (the `AIBrain` interface, add `descriptor?`)
- Modify: `apps/electron/electron/main/services/brains/index.ts` (export)

**Interfaces:**
- Consumes: `AIBrain`, `BrainCapability`, `BrainEffort` from `brains/types.ts`.
- Produces (later tasks rely on these exact names):
  - `type HarnessKind = 'api' | 'local' | 'cli' | 'special' | 'engine'`
  - `type LatencyClass = 'fast' | 'medium' | 'slow' | 'heavy'`
  - `type HarnessCapability = 'text' | 'json-schema' | 'vision' | 'audio' | 'timestamps' | 'diarization' | 'embedding' | 'streaming' | 'long-context' | 'agentic' | 'classification'`
  - `type EffortControl = { kind: 'none' } | { kind: 'levels'; levels: readonly BrainEffort[] } | { kind: 'thinking-budget' }`
  - `type HarnessNeeds = 'api-key' | 'cli-login' | 'running-server' | 'model-files' | 'none'`
  - `interface HarnessDescriptor { id: string; label: string; kind: HarnessKind; vendor: string; dataLeavesMachine: boolean; latency: LatencyClass; capabilities: ReadonlySet<HarnessCapability>; effort: EffortControl; needs: HarnessNeeds; modelSelectable: boolean }`
  - `interface ModelInfo { id: string; label?: string; note?: string }`
  - `caps(...list: HarnessCapability[]): ReadonlySet<HarnessCapability>`
  - `BRAIN_CAPABILITY_TO_HARNESS: Record<BrainCapability, HarnessCapability>`
  - `describeBrain(brain: AIBrain): HarnessDescriptor`
  - `missingCapabilities(d: HarnessDescriptor, required: readonly HarnessCapability[]): HarnessCapability[]`
  - `AIBrain.descriptor?(): HarnessDescriptor`

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/main/services/brains/__tests__/descriptor.test.ts`:

```ts
/**
 * Harness descriptor vocabulary: the shared words the pipeline uses to say what a harness can do.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { BRAIN_CAPABILITY_TO_HARNESS, caps, describeBrain, missingCapabilities } from '../descriptor'
import type { HarnessDescriptor } from '../descriptor'
import type { AIBrain, BrainCapability } from '../types'

function bareBrain(over: Partial<AIBrain> = {}): AIBrain {
  return {
    id: 'ollama',
    label: 'Bare brain',
    capabilities: () => new Set<BrainCapability>(['generate', 'chat', 'embed']),
    authStatus: async () => ({ configured: true, method: 'none' }),
    generate: async () => null,
    chat: async () => null,
    ...over
  }
}

const own: HarnessDescriptor = {
  id: 'ollama',
  label: 'Own',
  kind: 'local',
  vendor: 'local',
  dataLeavesMachine: false,
  latency: 'medium',
  capabilities: caps('text'),
  effort: { kind: 'none' },
  needs: 'running-server',
  modelSelectable: true
}

describe('describeBrain', () => {
  it('uses the descriptor the brain provides', () => {
    expect(describeBrain(bareBrain({ descriptor: () => own }))).toBe(own)
  })

  it('derives one from the capabilities of a brain that has none (a fake, an old adapter)', () => {
    const derived = describeBrain(bareBrain())
    expect(derived.id).toBe('ollama')
    expect(derived.label).toBe('Bare brain')
    expect([...derived.capabilities].sort()).toEqual(['embedding', 'text'])
    // Unknown means cautious: the data is assumed to leave the machine and the harness to be slow.
    expect(derived.dataLeavesMachine).toBe(true)
    expect(derived.effort).toEqual({ kind: 'none' })
  })
})

describe('missingCapabilities', () => {
  it('names what a harness lacks, in the order asked', () => {
    const d = { ...own, capabilities: caps('text', 'json-schema') }
    expect(missingCapabilities(d, ['audio', 'text', 'timestamps'])).toEqual(['audio', 'timestamps'])
    expect(missingCapabilities(d, ['text'])).toEqual([])
  })
})

describe('vocabulary', () => {
  it('maps every brain capability to a descriptor capability', () => {
    const all: BrainCapability[] = ['generate', 'chat', 'analyzeAudio', 'embed', 'agentic']
    for (const c of all) expect(BRAIN_CAPABILITY_TO_HARNESS[c], c).toBeTruthy()
    expect(Object.keys(BRAIN_CAPABILITY_TO_HARNESS).sort()).toEqual([...all].sort())
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/electron`): `lowrun npx vitest run electron/main/services/brains/__tests__/descriptor.test.ts`
Expected: FAIL, "Failed to resolve import '../descriptor'".

- [ ] **Step 3: Write the implementation**

Create `apps/electron/electron/main/services/brains/descriptor.ts`:

```ts
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
  | 'json-schema' // can be made to answer in a given JSON shape by the harness itself
  | 'vision'
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
```

In `apps/electron/electron/main/services/brains/types.ts`, add the type import at the top of the file (after the header comment, before `export type BrainId`):

```ts
import type { HarnessDescriptor, ModelInfo } from './descriptor'
```

and in `interface AIBrain`, after `authStatus(): Promise<BrainAuthStatus>`:

```ts
  /** What this brain can do and costs, in the words the pipeline uses. See descriptor.ts. */
  descriptor?(): HarnessDescriptor
  /** The models this brain offers, when it can list them. Never throws; `[]` when it cannot. */
  listModels?(): Promise<ModelInfo[]>
```

In `apps/electron/electron/main/services/brains/index.ts`, add after `export * from './types'`:

```ts
export * from './descriptor'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/descriptor.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node`
Expected: no output after the two `npm notice` lines.

```bash
git add apps/electron/electron/main/services/brains/descriptor.ts apps/electron/electron/main/services/brains/__tests__/descriptor.test.ts apps/electron/electron/main/services/brains/types.ts apps/electron/electron/main/services/brains/index.ts
git commit -m "Brains: a descriptor vocabulary for what a harness can do"
```

---

### Task 2: A descriptor on each of the seven brains

**Files:**
- Modify: `apps/electron/electron/main/services/brains/gemini-api-brain.ts`, `ollama-brain.ts`, `local-onnx-embed-brain.ts`, `claude-code-brain.ts`, `codex-brain.ts`, `gemini-cli-brain.ts`, `kiro-cli-brain.ts`
- Create: `apps/electron/electron/main/services/brains/__tests__/descriptor-contract.test.ts`

**Interfaces:**
- Consumes: `caps`, `HarnessDescriptor` from Task 1.
- Produces: `descriptor()` on every brain returned by `getBrainRegistry().list()`, with the values in the table below.

| id | kind | vendor | leaves machine | latency | capabilities | effort | needs | model selectable |
|---|---|---|---|---|---|---|---|---|
| gemini-api | api | Google | yes | fast | text, json-schema, vision, audio, long-context, embedding | thinking-budget | api-key | yes |
| ollama | local | local | no | medium | text, json-schema, embedding | none | running-server | yes |
| local-onnx-embed | local | local | no | fast | embedding | none | model-files | no |
| claude-code | cli | Anthropic | yes | slow | text, agentic, long-context | levels low, medium, high, xhigh, max | cli-login | yes |
| codex | cli | OpenAI | yes | slow | text, agentic | levels low, medium, high | cli-login | yes |
| gemini-cli | cli | Google | yes | slow | text, agentic | none | cli-login | yes |
| kiro | cli | AWS | yes | slow | text, agentic | levels low, medium, high, xhigh, max | cli-login | no |

Kiro's model is not selectable because `kiro-cli` 2.24.1 answers `--model` with "Method not found" and runs on its default (measured 30-sep-2026); its `--effort` flag is accepted. Codex maps `xhigh` and `max` to `high` (already so in `codex-brain.ts`).

- [ ] **Step 1: Write the failing contract test**

Create `apps/electron/electron/main/services/brains/__tests__/descriptor-contract.test.ts`:

```ts
/**
 * Every brain the registry builds describes itself, and what it says agrees with what it does.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// Same stubs as brain-registry.test.ts: the registry constructs the real brains, and constructing
// them must not touch Electron or the network.
vi.mock('../../config', () => ({ getConfig: () => ({ brains: {} }) }))
vi.mock('../../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

import { getBrainRegistry, resetBrainRegistry } from '../brain-registry'
import { BRAIN_CAPABILITY_TO_HARNESS } from '../descriptor'

describe('every registered brain describes itself', () => {
  afterEach(() => resetBrainRegistry())

  it('has its own descriptor (not the derived one), with its id and label', () => {
    for (const brain of getBrainRegistry().list()) {
      expect(brain.descriptor, `${brain.id} has no descriptor()`).toBeTypeOf('function')
      const d = brain.descriptor!()
      expect(d.id).toBe(brain.id)
      expect(d.label).toBe(brain.label)
    }
  })

  it('advertises at least what the brain can do', () => {
    for (const brain of getBrainRegistry().list()) {
      const d = brain.descriptor!()
      for (const c of brain.capabilities()) {
        expect(d.capabilities.has(BRAIN_CAPABILITY_TO_HARNESS[c]), `${brain.id}: ${c}`).toBe(true)
      }
    }
  })

  it('keeps data on the machine for local brains and says it leaves for the rest', () => {
    const byId = new Map(getBrainRegistry().list().map((b) => [b.id, b.descriptor!()]))
    expect(byId.get('ollama')!.dataLeavesMachine).toBe(false)
    expect(byId.get('local-onnx-embed')!.dataLeavesMachine).toBe(false)
    for (const id of ['gemini-api', 'claude-code', 'codex', 'gemini-cli', 'kiro'] as const) {
      expect(byId.get(id)!.dataLeavesMachine, id).toBe(true)
    }
  })

  it('states how effort is set, only where the harness has the notion', () => {
    const byId = new Map(getBrainRegistry().list().map((b) => [b.id, b.descriptor!()]))
    expect(byId.get('gemini-api')!.effort).toEqual({ kind: 'thinking-budget' })
    expect(byId.get('ollama')!.effort).toEqual({ kind: 'none' })
    expect(byId.get('claude-code')!.effort).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(byId.get('codex')!.effort).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high'] })
    expect(byId.get('kiro')!.effort).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
  })

  it('marks the harnesses that ignore a chosen model', () => {
    const byId = new Map(getBrainRegistry().list().map((b) => [b.id, b.descriptor!()]))
    expect(byId.get('kiro')!.modelSelectable).toBe(false)
    expect(byId.get('local-onnx-embed')!.modelSelectable).toBe(false)
    expect(byId.get('claude-code')!.modelSelectable).toBe(true)
  })

  it('says what each one needs before it can run', () => {
    const byId = new Map(getBrainRegistry().list().map((b) => [b.id, b.descriptor!()]))
    expect(byId.get('gemini-api')!.needs).toBe('api-key')
    expect(byId.get('ollama')!.needs).toBe('running-server')
    expect(byId.get('local-onnx-embed')!.needs).toBe('model-files')
    expect(byId.get('claude-code')!.needs).toBe('cli-login')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/descriptor-contract.test.ts`
Expected: FAIL, "gemini-api has no descriptor()".

- [ ] **Step 3: Add `descriptor()` to each brain**

In each file, add `import { caps, type HarnessDescriptor } from './descriptor'` next to the other imports of the file, and add the method right after the existing `capabilities()` method of the class.

`gemini-api-brain.ts`:

```ts
  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'api',
      vendor: 'Google',
      dataLeavesMachine: true,
      latency: 'fast',
      capabilities: caps('text', 'json-schema', 'vision', 'audio', 'long-context', 'embedding'),
      effort: { kind: 'thinking-budget' },
      needs: 'api-key',
      modelSelectable: true
    }
  }
```

`ollama-brain.ts`:

```ts
  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'local',
      vendor: 'local',
      dataLeavesMachine: false,
      latency: 'medium',
      capabilities: caps('text', 'json-schema', 'embedding'),
      effort: { kind: 'none' },
      needs: 'running-server',
      modelSelectable: true
    }
  }
```

`local-onnx-embed-brain.ts`:

```ts
  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'local',
      vendor: 'local',
      dataLeavesMachine: false,
      latency: 'fast',
      capabilities: caps('embedding'),
      effort: { kind: 'none' },
      needs: 'model-files',
      modelSelectable: false
    }
  }
```

`claude-code-brain.ts`:

```ts
  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'cli',
      vendor: 'Anthropic',
      dataLeavesMachine: true,
      latency: 'slow',
      capabilities: caps('text', 'agentic', 'long-context'),
      effort: { kind: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      needs: 'cli-login',
      modelSelectable: true
    }
  }
```

`codex-brain.ts`:

```ts
  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'cli',
      vendor: 'OpenAI',
      dataLeavesMachine: true,
      latency: 'slow',
      capabilities: caps('text', 'agentic'),
      // xhigh and max run as high (see the effort mapping in this file).
      effort: { kind: 'levels', levels: ['low', 'medium', 'high'] },
      needs: 'cli-login',
      modelSelectable: true
    }
  }
```

`gemini-cli-brain.ts`:

```ts
  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'cli',
      vendor: 'Google',
      dataLeavesMachine: true,
      latency: 'slow',
      capabilities: caps('text', 'agentic'),
      effort: { kind: 'none' },
      needs: 'cli-login',
      modelSelectable: true
    }
  }
```

`kiro-cli-brain.ts`:

```ts
  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'cli',
      vendor: 'AWS',
      dataLeavesMachine: true,
      latency: 'slow',
      capabilities: caps('text', 'agentic'),
      effort: { kind: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      needs: 'cli-login',
      // kiro-cli 2.24.1 answers --model with "Method not found" and runs on its default.
      modelSelectable: false
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `lowrun npx vitest run electron/main/services/brains`
Expected: PASS, every test of the folder (the descriptor contract adds 6).

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/brains
git commit -m "Brains: every adapter says what it can do, costs and needs"
```

---

### Task 3: The OpenAI-compatible adapter

**Files:**
- Create: `apps/electron/electron/main/services/brains/openai-compatible-brain.ts`
- Create: `apps/electron/electron/main/services/brains/__tests__/openai-compatible-brain.test.ts`
- Modify: `brains/types.ts` (`BrainId`), `brains/brain-registry.ts`, `brains/index.ts`
- Modify: `apps/electron/electron/main/services/config.ts` (`AppConfig.brains`, `DEFAULT_CONFIG.brains`)
- Modify: `apps/electron/electron/preload/index.ts` (the `BrainId` mirror)
- Modify: `brains/__tests__/brain-registry.test.ts` (eight brains), `brains/__tests__/descriptor-contract.test.ts` (one more expectation)

**Interfaces:**
- Consumes: `caps`, `HarnessDescriptor`, `ModelInfo` (Task 1); `eligibleToGenerate`; `getBrainCredentialStore`.
- Produces:
  - `BrainId` gains `'openai-compatible'`.
  - `interface OpenAiCompatibleSettings { baseUrl: string; model: string; embeddingModel: string }`
  - `interface OpenAiCompatibleDeps { fetchImpl?: typeof fetch; getSettings?: () => OpenAiCompatibleSettings; getApiKey?: () => string }`
  - `class OpenAiCompatibleBrain implements AIBrain` with `id = 'openai-compatible'`, `generate`, `chat`, `embed`, `authStatus`, `listModels`, `descriptor`.
  - `isLoopbackUrl(url: string): boolean`
  - Config: `config.brains.openaiCompatible?: OpenAiCompatibleSettings`, default `{ baseUrl: 'http://localhost:1234/v1', model: '', embeddingModel: '' }`, and `config.brains.enabled['openai-compatible']` default `false`.
  - The optional secret is in the credential store as brain `'openai-compatible'`, field `'apiKey'`.

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/main/services/brains/__tests__/openai-compatible-brain.test.ts`:

```ts
/**
 * OpenAiCompatibleBrain: any server that speaks the OpenAI REST protocol (LM Studio, llama.cpp
 * server, vLLM). Tested against a scripted fetch; no network.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../config', () => ({ getConfig: () => ({ brains: {} }) }))
vi.mock('../brain-credential-store', () => ({ getBrainCredentialStore: () => ({ getSecret: () => null }) }))

import { OpenAiCompatibleBrain, isLoopbackUrl, type OpenAiCompatibleSettings } from '../openai-compatible-brain'

const SETTINGS: OpenAiCompatibleSettings = {
  baseUrl: 'http://localhost:1234/v1',
  model: 'qwen3-8b',
  embeddingModel: 'nomic-embed'
}

// A stand-in for the optional key. It is a variable, not a literal next to the word "key", so the
// repository's secret gate does not mistake a test value for a credential.
const HEADER_VALUE = 'value-used-only-in-this-test'

interface Call {
  url: string
  init: RequestInit
}

function scriptedFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return reply(call)
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function make(fetchImpl: typeof fetch, over: { settings?: Partial<OpenAiCompatibleSettings>; apiKey?: string } = {}) {
  return new OpenAiCompatibleBrain({
    fetchImpl,
    getSettings: () => ({ ...SETTINGS, ...over.settings }),
    getApiKey: () => over.apiKey ?? ''
  })
}

const body = (call: Call) => JSON.parse(String(call.init.body)) as Record<string, unknown>

describe('OpenAiCompatibleBrain', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('advertises text and embeddings, no audio and no agent', () => {
    const brain = make(scriptedFetch(() => json({})).fn)
    expect([...brain.capabilities()].sort()).toEqual(['chat', 'embed', 'generate'])
  })

  describe('descriptor', () => {
    it('keeps the data on the machine for a loopback server', () => {
      expect(make(scriptedFetch(() => json({})).fn).descriptor().dataLeavesMachine).toBe(false)
      expect(make(scriptedFetch(() => json({})).fn, { settings: { baseUrl: 'http://127.0.0.1:8080/v1' } }).descriptor().dataLeavesMachine).toBe(false)
      expect(make(scriptedFetch(() => json({})).fn, { settings: { baseUrl: 'http://[::1]:8080/v1' } }).descriptor().dataLeavesMachine).toBe(false)
    })

    it('says the data leaves the machine for a server on the network', () => {
      const brain = make(scriptedFetch(() => json({})).fn, { settings: { baseUrl: 'http://192.168.1.20:1234/v1' } })
      expect(brain.descriptor().dataLeavesMachine).toBe(true)
      expect(brain.descriptor().needs).toBe('running-server')
    })

    it('isLoopbackUrl rejects what is not a loopback host, and what is not a URL', () => {
      expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true)
      expect(isLoopbackUrl('http://localhost.evil.example/v1')).toBe(false)
      expect(isLoopbackUrl('not a url')).toBe(false)
    })
  })

  describe('generate', () => {
    it('posts to /chat/completions and returns the message content', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: ' hello ' } }] }))
      const out = await make(f.fn).generate([{ role: 'user', content: 'hi' }], {
        systemPrompt: 'be brief',
        temperature: 0.2,
        maxTokens: 50,
        json: true
      })
      expect(out).toBe(' hello ')
      expect(f.calls).toHaveLength(1)
      expect(f.calls[0].url).toBe('http://localhost:1234/v1/chat/completions')
      expect(body(f.calls[0])).toEqual({
        model: 'qwen3-8b',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' }
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: 50,
        response_format: { type: 'json_object' }
      })
    })

    it('does not add a system prompt when the messages already carry one', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: 'x' } }] }))
      await make(f.fn).generate(
        [{ role: 'system', content: 'own' }, { role: 'user', content: 'hi' }],
        { systemPrompt: 'ignored' }
      )
      expect((body(f.calls[0]).messages as unknown[]).length).toBe(2)
    })

    it('uses the model of the call over the configured one, and omits it when neither is set', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: 'x' } }] }))
      await make(f.fn).generate([{ role: 'user', content: 'hi' }], { model: 'other' })
      expect(body(f.calls[0]).model).toBe('other')
      await make(f.fn, { settings: { model: '' } }).generate([{ role: 'user', content: 'hi' }])
      expect('model' in body(f.calls[1])).toBe(false)
    })

    it('sends the key only when one is set, and never in the URL', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: 'x' } }] }))
      await make(f.fn).generate([{ role: 'user', content: 'hi' }])
      expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
      await make(f.fn, { apiKey: HEADER_VALUE }).generate([{ role: 'user', content: 'hi' }])
      expect((f.calls[1].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${HEADER_VALUE}`)
      expect(f.calls[1].url).not.toContain(HEADER_VALUE)
    })

    it('returns null, and throws nothing, when the server is down, errors, or answers badly', async () => {
      const down = scriptedFetch(() => {
        throw new TypeError('fetch failed')
      })
      expect(await make(down.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
      const serverError = scriptedFetch(() => json({ error: 'boom' }, 500))
      expect(await make(serverError.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
      const notJson = scriptedFetch(() => new Response('<html>', { status: 200 }))
      expect(await make(notJson.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
      const noChoices = scriptedFetch(() => json({ choices: [] }))
      expect(await make(noChoices.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
      const emptyText = scriptedFetch(() => json({ choices: [{ message: { content: '  ' } }] }))
      expect(await make(emptyText.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
    })

    it('never logs the prompt', async () => {
      const f = scriptedFetch(() => json({ error: 'boom' }, 500))
      await make(f.fn).generate([{ role: 'user', content: 'SECRET-TRANSCRIPT-TEXT' }])
      const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
      expect(logged).not.toContain('SECRET-TRANSCRIPT-TEXT')
    })

    it('stops when the caller aborts', async () => {
      const controller = new AbortController()
      const f = scriptedFetch((call) => {
        controller.abort()
        if ((call.init.signal as AbortSignal).aborted) throw new DOMException('aborted', 'AbortError')
        return json({ choices: [{ message: { content: 'x' } }] })
      })
      expect(await make(f.fn).generate([{ role: 'user', content: 'hi' }], { signal: controller.signal })).toBeNull()
    })

    it('chat is generate with the history', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: 'reply' } }] }))
      const out = await make(f.fn).chat([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' }
      ])
      expect(out).toBe('reply')
      expect((body(f.calls[0]).messages as unknown[]).length).toBe(3)
    })
  })

  describe('embed', () => {
    it('posts to /embeddings and returns one vector per text, in order', async () => {
      const f = scriptedFetch(() =>
        json({ data: [{ index: 1, embedding: [2, 2] }, { index: 0, embedding: [1, 1] }] })
      )
      const out = await make(f.fn).embed(['a', 'b'])
      expect(out).toEqual([[1, 1], [2, 2]])
      expect(f.calls[0].url).toBe('http://localhost:1234/v1/embeddings')
      expect(body(f.calls[0])).toEqual({ model: 'nomic-embed', input: ['a', 'b'] })
    })

    it('reads a server that leaves out the index by position', async () => {
      const f = scriptedFetch(() => json({ data: [{ embedding: [1] }, { embedding: [2] }] }))
      expect(await make(f.fn).embed(['a', 'b'])).toEqual([[1], [2]])
    })

    it('returns a null for every text the server did not answer, so the length always matches', async () => {
      const short = scriptedFetch(() => json({ data: [{ index: 0, embedding: [1] }] }))
      expect(await make(short.fn).embed(['a', 'b', 'c'])).toEqual([[1], null, null])
      const down = scriptedFetch(() => json({}, 503))
      expect(await make(down.fn).embed(['a', 'b'])).toEqual([null, null])
      expect(await make(down.fn).embed([])).toEqual([])
    })

    it('sends 64 texts per request', async () => {
      const f = scriptedFetch((call) => {
        const input = body(call).input as string[]
        return json({ data: input.map((_, i) => ({ index: i, embedding: [i] })) })
      })
      const texts = Array.from({ length: 130 }, (_, i) => `t${i}`)
      const out = await make(f.fn).embed(texts)
      expect(out).toHaveLength(130)
      expect(f.calls.map((c) => (body(c).input as string[]).length)).toEqual([64, 64, 2])
    })

    it('stops before the next request when the source is no longer eligible, and pads with nulls', async () => {
      const f = scriptedFetch((call) => {
        const input = body(call).input as string[]
        return json({ data: input.map((_, i) => ({ index: i, embedding: [1] })) })
      })
      let allowed = 1
      const texts = Array.from({ length: 130 }, (_, i) => `t${i}`)
      const out = await make(f.fn).embed(texts, { shouldGenerate: () => allowed-- > 0 })
      expect(f.calls).toHaveLength(1)
      expect(out).toHaveLength(130)
      expect(out.slice(0, 64).every((v) => v !== null)).toBe(true)
      expect(out.slice(64).every((v) => v === null)).toBe(true)
    })
  })

  describe('authStatus and listModels', () => {
    it('is configured when /models answers, and counts the models', async () => {
      const f = scriptedFetch(() => json({ data: [{ id: 'a' }, { id: 'b' }] }))
      const status = await make(f.fn).authStatus()
      expect(status.configured).toBe(true)
      expect(status.detail).toContain('2 models')
      expect(f.calls[0].url).toBe('http://localhost:1234/v1/models')
    })

    it('is not configured, and does not throw, when the server is unreachable', async () => {
      const f = scriptedFetch(() => {
        throw new TypeError('fetch failed')
      })
      const status = await make(f.fn).authStatus()
      expect(status.configured).toBe(false)
      expect(status.detail).toContain('http://localhost:1234/v1')
    })

    it('lists the model ids, and lists nothing when the server does not answer', async () => {
      const ok = scriptedFetch(() => json({ data: [{ id: 'qwen3-8b' }, { id: 'llama3.2' }, { nope: 1 }] }))
      expect(await make(ok.fn).listModels()).toEqual([{ id: 'qwen3-8b' }, { id: 'llama3.2' }])
      const bad = scriptedFetch(() => json({}, 500))
      expect(await make(bad.fn).listModels()).toEqual([])
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/openai-compatible-brain.test.ts`
Expected: FAIL, "Failed to resolve import '../openai-compatible-brain'".

- [ ] **Step 3: Write the adapter**

Create `apps/electron/electron/main/services/brains/openai-compatible-brain.ts`:

```ts
/**
 * OpenAI-compatible brain: any server that speaks the OpenAI REST protocol, on this machine or on
 * the local network. LM Studio, the llama.cpp server, vLLM and Ollama's own /v1 all do. Ollama also
 * has its own brain (ollama-brain.ts); this one is for everything else, and for Ollama on another
 * machine.
 *
 * Capabilities: generate, chat, embed. No audio, no agent.
 *
 * Semantics the router relies on (same as OllamaBrain): generate and chat return null when the
 * server is down, errors or answers with something unusable; embed returns one entry per text and
 * a null for every text it could not embed. Nothing throws.
 *
 * Confidentiality: the prompt goes in the request body only. It is never in the URL and never in the
 * log; a failure logs the path and the HTTP status. The optional key goes in the Authorization
 * header and comes from the credential store (brain 'openai-compatible', field 'apiKey').
 *
 * Privacy: the descriptor says the data stays on the machine only for a loopback address. A server
 * on the network is still "leaves the machine", because the Local only preset promises more than
 * "somewhere in the house".
 */
import { getConfig } from '../config'
import { getBrainCredentialStore } from './brain-credential-store'
import { caps, type HarnessDescriptor, type ModelInfo } from './descriptor'
import { eligibleToGenerate } from './eligibility'
import type {
  AIBrain,
  BrainAuthStatus,
  BrainCapability,
  BrainMessage,
  EmbedOptions,
  GenerateOptions
} from './types'

const CAPABILITIES: ReadonlySet<BrainCapability> = new Set<BrainCapability>(['generate', 'chat', 'embed'])

const REQUEST_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 4_000
const EMBED_BATCH = 64

export interface OpenAiCompatibleSettings {
  /** Includes the version path, for example http://localhost:1234/v1 */
  baseUrl: string
  /** Chat model. Empty means the server picks (LM Studio uses the model that is loaded). */
  model: string
  embeddingModel: string
}

export const DEFAULT_OPENAI_COMPATIBLE_SETTINGS: OpenAiCompatibleSettings = {
  baseUrl: 'http://localhost:1234/v1',
  model: '',
  embeddingModel: ''
}

export interface OpenAiCompatibleDeps {
  fetchImpl?: typeof fetch
  getSettings?: () => OpenAiCompatibleSettings
  getApiKey?: () => string
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>
}

interface EmbeddingsResponse {
  data?: Array<{ index?: unknown; embedding?: unknown }>
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>
}

/** True for localhost, 127.0.0.1 and ::1 only. Parsed, so localhost.evil.example does not pass. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

function withSystemPrompt(messages: BrainMessage[], systemPrompt?: string): BrainMessage[] {
  const hasSystem = messages.some((m) => m.role === 'system')
  return systemPrompt && !hasSystem ? [{ role: 'system', content: systemPrompt }, ...messages] : messages
}

function defaultGetSettings(): OpenAiCompatibleSettings {
  const saved = getConfig().brains?.openaiCompatible
  return { ...DEFAULT_OPENAI_COMPATIBLE_SETTINGS, ...(saved ?? {}) }
}

function defaultGetApiKey(): string {
  try {
    return getBrainCredentialStore().getSecret('openai-compatible', 'apiKey')?.trim() ?? ''
  } catch {
    return ''
  }
}

export class OpenAiCompatibleBrain implements AIBrain {
  readonly id = 'openai-compatible' as const
  readonly label = 'Local server (OpenAI-compatible)'

  private readonly fetchImpl: typeof fetch
  private readonly settings: () => OpenAiCompatibleSettings
  private readonly apiKey: () => string

  constructor(deps: OpenAiCompatibleDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.settings = deps.getSettings ?? defaultGetSettings
    this.apiKey = deps.getApiKey ?? defaultGetApiKey
  }

  capabilities(): ReadonlySet<BrainCapability> {
    return CAPABILITIES
  }

  descriptor(): HarnessDescriptor {
    return {
      id: this.id,
      label: this.label,
      kind: 'local',
      vendor: 'local',
      dataLeavesMachine: !isLoopbackUrl(this.settings().baseUrl),
      latency: 'medium',
      capabilities: caps('text', 'json-schema', 'embedding'),
      effort: { kind: 'none' },
      needs: 'running-server',
      modelSelectable: true
    }
  }

  async authStatus(): Promise<BrainAuthStatus> {
    const models = await this.fetchModels()
    if (models === null) {
      return { configured: false, method: 'none', detail: `not reachable at ${this.settings().baseUrl}` }
    }
    return {
      configured: true,
      method: this.apiKey() ? 'api-key' : 'none',
      detail: `${models.length} model${models.length === 1 ? '' : 's'} available`
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.fetchModels()) ?? []
  }

  async generate(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    const chatMessages = withSystemPrompt(messages, opts.systemPrompt)
    if (chatMessages.length === 0) return null
    const body: Record<string, unknown> = { messages: chatMessages, stream: false }
    const model = opts.model || this.settings().model
    if (model) body.model = model
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
    if (opts.json) body.response_format = { type: 'json_object' }
    const data = (await this.post('/chat/completions', body, opts.signal)) as ChatCompletion | null
    const content = data?.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() ? content : null
  }

  async chat(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    return this.generate(messages, opts)
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<(number[] | null)[]> {
    if (texts.length === 0) return []
    const model = this.settings().embeddingModel
    const out: (number[] | null)[] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      // Re-checked before EACH request, like the other embed adapters (ADV43-2).
      if (!eligibleToGenerate(opts.shouldGenerate)) break
      const slice = texts.slice(i, i + EMBED_BATCH)
      const data = (await this.post('/embeddings', { ...(model ? { model } : {}), input: slice })) as EmbeddingsResponse | null
      const byIndex = new Map<number, number[]>()
      ;(data?.data ?? []).forEach((item, position) => {
        if (!Array.isArray(item.embedding)) return
        byIndex.set(typeof item.index === 'number' ? item.index : position, item.embedding as number[])
      })
      for (let j = 0; j < slice.length; j++) out.push(byIndex.get(j) ?? null)
    }
    while (out.length < texts.length) out.push(null)
    return out
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const key = this.apiKey()
    if (key) headers.Authorization = `Bearer ${key}`
    return headers
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown | null> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(joinUrl(this.settings().baseUrl, path), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      if (!res.ok) {
        console.error(`[OpenAiCompatibleBrain] ${path} returned HTTP ${res.status}`)
        return null
      }
      return (await res.json()) as unknown
    } catch (e) {
      // An abort by the caller is not a failure worth a log line. The message never holds the prompt.
      if (!signal?.aborted) {
        console.error(`[OpenAiCompatibleBrain] ${path} failed:`, e instanceof Error ? e.message : String(e))
      }
      return null
    }
  }

  private async fetchModels(): Promise<ModelInfo[] | null> {
    try {
      const res = await this.fetchImpl(joinUrl(this.settings().baseUrl, '/models'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const data = (await res.json()) as ModelsResponse
      return (data.data ?? [])
        .filter((m): m is { id: string } => typeof m.id === 'string' && m.id.length > 0)
        .map((m) => ({ id: m.id }))
    } catch {
      return null
    }
  }
}
```

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/openai-compatible-brain.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Register the brain, add its id and its settings**

In `brains/types.ts`, in `type BrainId`, add after the `'kiro'` line:

```ts
  | 'openai-compatible' // any OpenAI-protocol server: LM Studio, llama.cpp, vLLM (pipeline phase 1)
```

In `electron/preload/index.ts`, add the same member to the mirrored `BrainId` union (the union at lines 18-25) after `| 'kiro'`:

```ts
  | 'openai-compatible'
```

In `brains/brain-registry.ts`, add the import `import { OpenAiCompatibleBrain } from './openai-compatible-brain'` and, at the end of `REGISTRATIONS`:

```ts
  () => new OpenAiCompatibleBrain(),
```

In `brains/index.ts`, add:

```ts
export { OpenAiCompatibleBrain, isLoopbackUrl } from './openai-compatible-brain'
export type { OpenAiCompatibleSettings } from './openai-compatible-brain'
```

In `config.ts`, in the `brains` block of `interface AppConfig` (line 271), add after `taskRouting`:

```ts
    /** The OpenAI-compatible server (LM Studio, llama.cpp, vLLM). The optional key is in the credential store. */
    openaiCompatible?: { baseUrl: string; model: string; embeddingModel: string }
```

and in `DEFAULT_CONFIG.brains` (line 419), add `'openai-compatible': false` to `enabled` and, after `taskRouting: {},`:

```ts
    openaiCompatible: { baseUrl: 'http://localhost:1234/v1', model: '', embeddingModel: '' },
```

The saved config is merged over these defaults by `deepMerge` (`config.ts` line 648), so an existing `config.json` without the new keys loads with them.

In `brains/__tests__/brain-registry.test.ts`, change the first test to expect eight brains:

```ts
  it('registers all eight brains by id', () => {
    const registry = getBrainRegistry()
    const ids = registry.list().map((b) => b.id).sort()
    expect(ids).toEqual([
      'claude-code',
      'codex',
      'gemini-api',
      'gemini-cli',
      'kiro',
      'local-onnx-embed',
      'ollama',
      'openai-compatible'
    ])
  })
```

In `brains/__tests__/descriptor-contract.test.ts`, extend the "keeps data on the machine" test with the new brain (its default address is loopback) by adding, before the closing of that test:

```ts
    expect(byId.get('openai-compatible')!.dataLeavesMachine).toBe(false)
```

- [ ] **Step 6: Run the folder tests, the type contract and the typecheck**

Run: `lowrun npx vitest run electron/main/services/brains electron/main/services/__tests__/config` then `lowrun npm run typecheck:node`
Expected: PASS; the `brain-id-contract` test (which compares the main and the preload `BrainId`) still passes; no type errors. If `tsc` reports a `Record<BrainId, ...>` that lacks the new key, add it there with the value that keeps today's behaviour (`false` for switches).

- [ ] **Step 7: Commit**

```bash
git add apps/electron/electron/main/services/brains apps/electron/electron/main/services/config.ts apps/electron/electron/preload/index.ts
git commit -m "Brains: an OpenAI-compatible adapter for LM Studio, llama.cpp and vLLM"
```

---

### Task 4: Descriptors of the engines that are not brains, and one catalog

Audio work and Jev do not go through `BrainRouter`, but the Pipeline page must offer them in the same list and with the same words. This task describes them and builds `listHarnessDescriptors()`. The embedding engines are brains already (`gemini-api`, `ollama`, `local-onnx-embed`, `openai-compatible`) and appear through their own descriptors.

**Files:**
- Create: `apps/electron/electron/main/services/brains/engine-descriptors.ts`
- Create: `apps/electron/electron/main/services/brains/harness-catalog.ts`
- Create: `apps/electron/electron/main/services/brains/__tests__/harness-catalog.test.ts`
- Modify: `apps/electron/electron/main/services/brains/index.ts`

**Interfaces:**
- Consumes: `caps`, `HarnessDescriptor`, `describeBrain`, `missingCapabilities` (Task 1); `getBrainRegistry`, `BrainRegistry`.
- Produces:
  - `ENGINE_DESCRIPTORS: readonly HarnessDescriptor[]` with ids `gemini-transcribe`, `local-asr`, `vibevoice`, `model-host`, `pyannote-onnx`, `gemini-live`
  - `JEV_DESCRIPTOR: HarnessDescriptor` with id `jev`
  - `listHarnessDescriptors(registry?: BrainRegistry): HarnessDescriptor[]` (brains, then engines, then Jev)
  - `harnessesWith(required: readonly HarnessCapability[], registry?: BrainRegistry): HarnessDescriptor[]`
  - `findHarness(id: string, registry?: BrainRegistry): HarnessDescriptor | null`

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/main/services/brains/__tests__/harness-catalog.test.ts`:

```ts
/**
 * One list of every harness the pipeline can name: the brains, the audio engines and Jev.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../config', () => ({ getConfig: () => ({ brains: {} }) }))
vi.mock('../../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))

import { resetBrainRegistry } from '../brain-registry'
import { ENGINE_DESCRIPTORS, JEV_DESCRIPTOR } from '../engine-descriptors'
import { findHarness, harnessesWith, listHarnessDescriptors } from '../harness-catalog'

describe('harness catalog', () => {
  afterEach(() => resetBrainRegistry())

  it('lists the brains, the engines and Jev, each id once', () => {
    const ids = listHarnessDescriptors().map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['gemini-api', 'ollama', 'openai-compatible', 'claude-code', 'kiro']) expect(ids).toContain(id)
    for (const d of ENGINE_DESCRIPTORS) expect(ids).toContain(d.id)
    expect(ids).toContain('jev')
  })

  it('finds a harness by id, and null for an id it does not know', () => {
    expect(findHarness('vibevoice')?.kind).toBe('engine')
    expect(findHarness('jev')).toBe(JEV_DESCRIPTOR)
    expect(findHarness('nope')).toBeNull()
  })

  it('says which audio engines give timestamps and speakers', () => {
    const asr = (id: string) => findHarness(id)!
    for (const id of ['gemini-transcribe', 'vibevoice']) {
      expect(asr(id).capabilities.has('timestamps'), id).toBe(true)
      expect(asr(id).capabilities.has('diarization'), id).toBe(true)
    }
    expect(asr('gemini-live').capabilities.has('streaming')).toBe(true)
    expect(asr('pyannote-onnx').capabilities.has('audio')).toBe(true)
    expect(asr('pyannote-onnx').capabilities.has('timestamps')).toBe(false)
  })

  it('offers only harnesses that satisfy every capability asked for', () => {
    const transcribers = harnessesWith(['audio', 'timestamps', 'diarization']).map((d) => d.id).sort()
    expect(transcribers).toEqual(['gemini-transcribe', 'local-asr', 'vibevoice'])
    const embedders = harnessesWith(['embedding']).map((d) => d.id).sort()
    expect(embedders).toEqual(['gemini-api', 'local-onnx-embed', 'ollama', 'openai-compatible'])
    expect(harnessesWith(['classification']).map((d) => d.id)).toEqual(['jev'])
  })

  it('keeps audio engines that run on this machine local, and marks the network ones', () => {
    expect(findHarness('local-asr')!.dataLeavesMachine).toBe(false)
    expect(findHarness('vibevoice')!.dataLeavesMachine).toBe(false)
    expect(findHarness('pyannote-onnx')!.dataLeavesMachine).toBe(false)
    expect(findHarness('gemini-transcribe')!.dataLeavesMachine).toBe(true)
    // The Model Host is another machine: the audio leaves this one.
    expect(findHarness('model-host')!.dataLeavesMachine).toBe(true)
    expect(JEV_DESCRIPTOR.dataLeavesMachine).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/harness-catalog.test.ts`
Expected: FAIL, "Failed to resolve import '../engine-descriptors'".

- [ ] **Step 3: Write the two modules**

Create `apps/electron/electron/main/services/brains/engine-descriptors.ts`:

```ts
/**
 * Descriptors of the harnesses that are not brains: the audio engines transcription.ts and
 * speaker-linking.ts drive, and Jev. They are constants, not classes: nothing calls them through
 * the BrainRouter (audio stays outside it, and Jev answers questions, it does not write text).
 * They exist so the Pipeline page can offer them, and refuse an impossible pair, in the same
 * words as the brains.
 *
 * Sources (inventory 2026-09-30): rows 1 to 7 and 13 to 15. The model of each engine is chosen in
 * its own settings today (transcription.provider, transcription.speakerEngine); the choice moves
 * to the Pipeline page in phase 4 of the pipeline design.
 */
import { caps, type HarnessDescriptor } from './descriptor'

export const ENGINE_DESCRIPTORS: readonly HarnessDescriptor[] = [
  {
    id: 'gemini-transcribe',
    label: 'Gemini transcription',
    kind: 'engine',
    vendor: 'Google',
    dataLeavesMachine: true,
    latency: 'heavy',
    capabilities: caps('audio', 'timestamps', 'diarization', 'long-context'),
    effort: { kind: 'none' },
    needs: 'api-key',
    modelSelectable: true
  },
  {
    id: 'local-asr',
    label: 'Local ASR (Cohere transcribe)',
    kind: 'engine',
    vendor: 'local',
    dataLeavesMachine: false,
    latency: 'heavy',
    capabilities: caps('audio', 'timestamps', 'diarization'),
    effort: { kind: 'none' },
    needs: 'model-files',
    modelSelectable: false
  },
  {
    id: 'vibevoice',
    label: 'VibeVoice (local)',
    kind: 'engine',
    vendor: 'local',
    dataLeavesMachine: false,
    latency: 'heavy',
    capabilities: caps('audio', 'timestamps', 'diarization'),
    effort: { kind: 'none' },
    needs: 'model-files',
    modelSelectable: false
  },
  {
    id: 'model-host',
    label: 'Model Host',
    kind: 'engine',
    vendor: 'local',
    // Another machine of the owner's: the audio leaves this one.
    dataLeavesMachine: true,
    latency: 'heavy',
    capabilities: caps('audio', 'diarization'),
    effort: { kind: 'none' },
    needs: 'running-server',
    modelSelectable: false
  },
  {
    id: 'pyannote-onnx',
    label: 'Speaker segmentation (ONNX)',
    kind: 'engine',
    vendor: 'local',
    dataLeavesMachine: false,
    latency: 'heavy',
    capabilities: caps('audio', 'diarization'),
    effort: { kind: 'none' },
    needs: 'model-files',
    modelSelectable: false
  },
  {
    id: 'gemini-live',
    label: 'Gemini Live transcription',
    kind: 'engine',
    vendor: 'Google',
    dataLeavesMachine: true,
    latency: 'fast',
    capabilities: caps('audio', 'streaming', 'timestamps'),
    effort: { kind: 'none' },
    needs: 'api-key',
    modelSelectable: false
  }
]

/** Jev (TypeSafe System One): answers scored, chosen and yes-or-no questions, fast and cheap. It writes no text. */
export const JEV_DESCRIPTOR: HarnessDescriptor = {
  id: 'jev',
  label: 'Jev (System One)',
  kind: 'special',
  vendor: 'TypeSafe AI',
  dataLeavesMachine: true,
  latency: 'fast',
  capabilities: caps('classification'),
  effort: { kind: 'none' },
  needs: 'api-key',
  modelSelectable: false
}
```

Create `apps/electron/electron/main/services/brains/harness-catalog.ts`:

```ts
/**
 * Every harness the pipeline can name, in one list: the brains of the registry, the audio engines
 * and Jev. The Pipeline page reads it to fill its harness list and to grey out what a step cannot use.
 */
import { BrainRegistry, getBrainRegistry } from './brain-registry'
import { describeBrain, missingCapabilities, type HarnessCapability, type HarnessDescriptor } from './descriptor'
import { ENGINE_DESCRIPTORS, JEV_DESCRIPTOR } from './engine-descriptors'

export function listHarnessDescriptors(registry: BrainRegistry = getBrainRegistry()): HarnessDescriptor[] {
  return [...registry.list().map(describeBrain), ...ENGINE_DESCRIPTORS, JEV_DESCRIPTOR]
}

export function findHarness(id: string, registry: BrainRegistry = getBrainRegistry()): HarnessDescriptor | null {
  return listHarnessDescriptors(registry).find((d) => d.id === id) ?? null
}

/** The harnesses that have every capability in `required`. */
export function harnessesWith(
  required: readonly HarnessCapability[],
  registry: BrainRegistry = getBrainRegistry()
): HarnessDescriptor[] {
  return listHarnessDescriptors(registry).filter((d) => missingCapabilities(d, required).length === 0)
}
```

In `brains/index.ts` add:

```ts
export { ENGINE_DESCRIPTORS, JEV_DESCRIPTOR } from './engine-descriptors'
export { listHarnessDescriptors, findHarness, harnessesWith } from './harness-catalog'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/harness-catalog.test.ts`
Expected: PASS, 5 tests. If the `transcribers` list differs, the descriptor table above is the specification: fix the descriptor, not the test.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (expect no errors), then:

```bash
git add apps/electron/electron/main/services/brains
git commit -m "Brains: the audio engines and Jev described in the same words, and one catalog"
```

---

### Task 5: Model discovery

The Pipeline page offers a model combobox. This task gives each harness a way to list its models, and a cache in front so the page never waits on a dead server.

**Files:**
- Create: `apps/electron/electron/main/services/brains/model-discovery.ts`
- Create: `apps/electron/electron/main/services/brains/__tests__/model-discovery.test.ts`
- Modify: `apps/electron/electron/main/services/brains/gemini-api-brain.ts` (constructor deps, `listModels`)
- Modify: `apps/electron/electron/main/services/brains/ollama-brain.ts` (`listModels`)
- Modify: `apps/electron/electron/main/services/brains/kiro-cli-brain.ts` (`listModels`, `parseKiroModels`)
- Modify: `apps/electron/electron/main/services/brains/__tests__/gemini-api-brain.test.ts`, `ollama-brain.test.ts`, `kiro-cli-brain.test.ts` (one new `describe` each)
- Modify: `apps/electron/electron/main/services/brains/index.ts`

**Interfaces:**
- Consumes: `ModelInfo`, `AIBrain.listModels?` (Task 1); `runCli`, `SpawnFn` from `cli-runner.ts`; `CURRENT_GEMINI_CHAT_MODEL` from `../gemini-model-ids`.
- Produces:
  - `STATIC_MODELS: Partial<Record<BrainId, ModelInfo[]>>`
  - `discoverModels(brain: AIBrain, opts?: { now?: () => number; ttlMs?: number; failureTtlMs?: number; timeoutMs?: number }): Promise<ModelInfo[]>`
  - `resetModelDiscoveryCache(): void`
  - `parseKiroModels(stdout: string): ModelInfo[]`
  - `GeminiApiBrain` constructor `new GeminiApiBrain(deps?: { fetchImpl?: typeof fetch })`

- [ ] **Step 1: Write the failing discovery test**

Create `apps/electron/electron/main/services/brains/__tests__/model-discovery.test.ts`:

```ts
/**
 * Model discovery: ask a harness for its models without ever hanging, throwing or asking twice at once.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { discoverModels, resetModelDiscoveryCache, STATIC_MODELS } from '../model-discovery'
import type { ModelInfo } from '../descriptor'
import type { AIBrain, BrainId } from '../types'

function brainWith(id: BrainId, listModels?: () => Promise<ModelInfo[]>): AIBrain {
  return {
    id,
    label: id,
    capabilities: () => new Set(['generate']),
    authStatus: async () => ({ configured: true, method: 'none' }),
    generate: async () => null,
    chat: async () => null,
    ...(listModels ? { listModels } : {})
  } as AIBrain
}

describe('discoverModels', () => {
  beforeEach(() => resetModelDiscoveryCache())

  it('returns what the harness lists', async () => {
    const list = vi.fn(async () => [{ id: 'a' }, { id: 'b' }])
    expect(await discoverModels(brainWith('ollama', list))).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('asks once for callers that arrive together, and once per ttl', async () => {
    let now = 1_000
    const list = vi.fn(async () => [{ id: 'a' }])
    const brain = brainWith('ollama', list)
    const opts = { now: () => now, ttlMs: 60_000 }
    await Promise.all([discoverModels(brain, opts), discoverModels(brain, opts), discoverModels(brain, opts)])
    expect(list).toHaveBeenCalledTimes(1)
    now += 30_000
    await discoverModels(brain, opts)
    expect(list).toHaveBeenCalledTimes(1)
    now += 31_000
    await discoverModels(brain, opts)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('never throws: a failing source gives the last good list', async () => {
    let now = 1_000
    let fail = false
    const brain = brainWith('ollama', async () => {
      if (fail) throw new Error('down')
      return [{ id: 'a' }]
    })
    const opts = { now: () => now, ttlMs: 10, failureTtlMs: 10 }
    expect(await discoverModels(brain, opts)).toEqual([{ id: 'a' }])
    fail = true
    now += 1_000
    expect(await discoverModels(brain, opts)).toEqual([{ id: 'a' }])
  })

  it('gives up on a source that never answers, and says nothing rather than waiting', async () => {
    const brain = brainWith('ollama', () => new Promise<ModelInfo[]>(() => {}))
    const started = Date.now()
    expect(await discoverModels(brain, { timeoutMs: 50 })).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('uses the built-in list for a harness that cannot list, and nothing for an unknown one', async () => {
    const claude = await discoverModels(brainWith('claude-code'))
    expect(claude.map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(STATIC_MODELS['claude-code']).toBeDefined()
    expect(await discoverModels(brainWith('codex'))).toEqual([])
  })

  it('does not remember a failure for long: a server started a moment later shows up', async () => {
    let now = 1_000
    let up = false
    const brain = brainWith('openai-compatible', async () => (up ? [{ id: 'qwen' }] : []))
    const opts = { now: () => now, ttlMs: 60_000, failureTtlMs: 5_000 }
    expect(await discoverModels(brain, opts)).toEqual([])
    up = true
    now += 6_000
    expect(await discoverModels(brain, opts)).toEqual([{ id: 'qwen' }])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/model-discovery.test.ts`
Expected: FAIL, "Failed to resolve import '../model-discovery'".

- [ ] **Step 3: Write `model-discovery.ts`**

Create `apps/electron/electron/main/services/brains/model-discovery.ts`:

```ts
/**
 * Model discovery for the Pipeline page's model combobox.
 *
 * Contract: never throws, never waits longer than the timeout, asks a harness once for callers that
 * arrive together, and remembers a good answer for a minute and a failed one for five seconds (so a
 * server the owner starts a moment later shows up, and a dead one is not asked on every keystroke).
 * A harness that cannot list its models has a built-in list here, or none: the combobox always takes
 * free text.
 */
import { CURRENT_GEMINI_CHAT_MODEL } from '../gemini-model-ids'
import type { ModelInfo } from './descriptor'
import type { AIBrain, BrainId } from './types'

const TTL_MS = 60_000
const FAILURE_TTL_MS = 5_000
const TIMEOUT_MS = 6_000

/** Models known without asking. Claude Code takes aliases; the other CLIs take free text. */
export const STATIC_MODELS: Partial<Record<BrainId, ModelInfo[]>> = {
  'claude-code': [
    { id: 'haiku', label: 'Haiku', note: 'small and fast' },
    { id: 'sonnet', label: 'Sonnet', note: 'balanced' },
    { id: 'opus', label: 'Opus', note: 'strongest, slowest' }
  ],
  'gemini-cli': [{ id: CURRENT_GEMINI_CHAT_MODEL }]
}

interface Entry {
  models: ModelInfo[]
  expiresAt: number
  /** True when the list came from the harness, false when it is the built-in or the empty fallback. */
  fresh: boolean
}

const cache = new Map<BrainId, Entry>()
const inflight = new Map<BrainId, Promise<ModelInfo[]>>()

export function resetModelDiscoveryCache(): void {
  cache.clear()
  inflight.clear()
}

export interface DiscoverOptions {
  now?: () => number
  ttlMs?: number
  failureTtlMs?: number
  timeoutMs?: number
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('model list timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function discoverModels(brain: AIBrain, opts: DiscoverOptions = {}): Promise<ModelInfo[]> {
  const now = opts.now ?? Date.now
  const hit = cache.get(brain.id)
  if (hit && now() < hit.expiresAt) return hit.models
  const pending = inflight.get(brain.id)
  if (pending) return pending

  const run = (async (): Promise<ModelInfo[]> => {
    let listed: ModelInfo[] = []
    try {
      if (brain.listModels) listed = await withTimeout(brain.listModels(), opts.timeoutMs ?? TIMEOUT_MS)
    } catch {
      listed = []
    }
    if (listed.length > 0) {
      cache.set(brain.id, { models: listed, expiresAt: now() + (opts.ttlMs ?? TTL_MS), fresh: true })
      return listed
    }
    // The harness gave nothing: keep the last good list if there is one, else the built-in, else none.
    const fallback = hit?.fresh ? hit.models : (STATIC_MODELS[brain.id] ?? [])
    cache.set(brain.id, {
      models: fallback,
      expiresAt: now() + (opts.failureTtlMs ?? FAILURE_TTL_MS),
      fresh: hit?.fresh === true
    })
    return fallback
  })().finally(() => inflight.delete(brain.id))

  inflight.set(brain.id, run)
  return run
}
```

Note for the implementer: the failing-source test expects the last good list back, which is why `hit` is captured before the request and its `fresh` flag decides.

- [ ] **Step 4: Run the discovery test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/model-discovery.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing adapter tests**

Append to `brains/__tests__/gemini-api-brain.test.ts` (inside the file, after the last `describe`; the mocks at the top of the file already provide the config and the credential store):

```ts
describe('GeminiApiBrain.listModels', () => {
  it('lists the models that can generate, with the key in a header and not in the URL', async () => {
    mockGetSecret.mockReturnValue('key-from-store')
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(
        JSON.stringify({
          models: [
            { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] }
          ]
        }),
        { status: 200 }
      )
    }) as typeof fetch
    const models = await new GeminiApiBrain({ fetchImpl }).listModels()
    expect(models).toEqual([{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }])
    expect(calls[0].url).not.toContain('key-from-store')
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('key-from-store')
  })

  it('lists nothing, and does not throw, without a key or when the API fails', async () => {
    mockGetSecret.mockReturnValue(null)
    const never = (async () => {
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    expect(await new GeminiApiBrain({ fetchImpl: never }).listModels()).toEqual([])
    mockGetSecret.mockReturnValue('k')
    const failing = (async () => new Response('{}', { status: 500 })) as typeof fetch
    expect(await new GeminiApiBrain({ fetchImpl: failing }).listModels()).toEqual([])
  })
})
```

Append to `brains/__tests__/ollama-brain.test.ts` (the file mocks `../../ollama`; add `listModels: mockListModels` to the mocked service object: declare `const mockListModels = vi.fn()` next to the other mocks and add the key in the `getOllamaService` factory):

```ts
describe('OllamaBrain.listModels', () => {
  it('lists the installed models by name', async () => {
    mockListModels.mockResolvedValue(['llama3.2:latest', 'qwen3:8b'])
    expect(await new OllamaBrain().listModels()).toEqual([{ id: 'llama3.2:latest' }, { id: 'qwen3:8b' }])
  })

  it('lists nothing when Ollama is not running', async () => {
    mockListModels.mockRejectedValue(new Error('down'))
    expect(await new OllamaBrain().listModels()).toEqual([])
  })
})
```

Append to `brains/__tests__/kiro-cli-brain.test.ts` (which already imports `makeFakeSpawn`, `KiroCliBrain`; add `parseKiroModels` to its import from `../kiro-cli-brain`):

```ts
describe('Kiro model list', () => {
  const sample = JSON.stringify({
    models: [
      { model_name: 'auto', description: 'Chosen by task', model_id: 'auto', rate_multiplier: 1.0, rate_unit: 'Credit' },
      { model_name: 'claude-sonnet-5', description: 'Claude Sonnet 5', model_id: 'claude-sonnet-5', rate_multiplier: 1.3, rate_unit: 'Credit' }
    ]
  })

  it('parses the JSON of kiro-cli chat --list-models', () => {
    expect(parseKiroModels(sample)).toEqual([
      { id: 'auto', label: 'auto', note: 'Chosen by task' },
      { id: 'claude-sonnet-5', label: 'claude-sonnet-5', note: 'Claude Sonnet 5' }
    ])
  })

  it('parses nothing from output that is not that JSON', () => {
    expect(parseKiroModels('')).toEqual([])
    expect(parseKiroModels('not json')).toEqual([])
    expect(parseKiroModels('{"models": "x"}')).toEqual([])
    expect(parseKiroModels('{"models": [{"nope": 1}]}')).toEqual([])
  })

  it('asks the CLI for the list with fixed flags only', async () => {
    const spawn = makeFakeSpawn({ stdout: sample, code: 0 })
    const models = await new KiroCliBrain({ spawn: spawn.fn as never, env: {}, getStoredKey: () => '' }).listModels()
    expect(models.map((m) => m.id)).toEqual(['auto', 'claude-sonnet-5'])
    expect(spawn.calls[0].args).toEqual(['chat', '--list-models', '--format', 'json'])
  })

  it('lists nothing when the CLI fails', async () => {
    const spawn = makeFakeSpawn({ stdout: '', stderr: 'boom', code: 1 })
    expect(await new KiroCliBrain({ spawn: spawn.fn as never, env: {}, getStoredKey: () => '' }).listModels()).toEqual([])
  })
})
```

- [ ] **Step 6: Run the adapter tests to verify they fail**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/gemini-api-brain.test.ts electron/main/services/brains/__tests__/ollama-brain.test.ts electron/main/services/brains/__tests__/kiro-cli-brain.test.ts`
Expected: FAIL, "listModels is not a function" and "parseKiroModels is not a function".

- [ ] **Step 7: Implement `listModels` on the three adapters**

`gemini-api-brain.ts`: add `import type { ModelInfo } from './descriptor'` (extend the existing descriptor import from Task 2 to `caps, type HarnessDescriptor, type ModelInfo`), then in the class add a field and a constructor and the method:

```ts
  private readonly fetchImpl: typeof fetch

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  /**
   * The models the key can call for text. The key travels in a header, never in the URL. Lists
   * nothing (never throws) without a key or when the API answers badly.
   */
  async listModels(): Promise<ModelInfo[]> {
    const apiKey = resolveGeminiApiKey()
    if (!apiKey) return []
    try {
      const res = await this.fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(5_000)
      })
      if (!res.ok) return []
      const data = (await res.json()) as {
        models?: Array<{ name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }>
      }
      return (data.models ?? [])
        .filter(
          (m) =>
            typeof m.name === 'string' &&
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('generateContent')
        )
        .map((m) => {
          const id = String(m.name).replace(/^models\//, '')
          return typeof m.displayName === 'string' && m.displayName ? { id, label: m.displayName } : { id }
        })
    } catch {
      return []
    }
  }
```

`ollama-brain.ts`: add `type ModelInfo` to the descriptor import and:

```ts
  async listModels(): Promise<ModelInfo[]> {
    try {
      const names = await getOllamaService().listModels()
      return names.map((id) => ({ id }))
    } catch {
      return []
    }
  }
```

`kiro-cli-brain.ts`: add `type ModelInfo` to the descriptor import, and in the class:

```ts
  /** `kiro-cli chat --list-models --format json`: fixed flags, no prompt, no model call. */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await runCli(
        KIRO_CLI,
        ['chat', '--list-models', '--format', 'json'],
        { timeoutMs: PROBE_TIMEOUT_MS, env: this.env },
        this.spawn
      )
      if (res.code !== 0 || res.spawnError || res.timedOut) return []
      return parseKiroModels(res.stdout)
    } catch {
      return []
    }
  }
```

and at module level (next to `parseKiroOutput`):

```ts
/**
 * Parse the JSON of `kiro-cli chat --list-models --format json`:
 * `{ "models": [{ "model_id": "auto", "model_name": "auto", "description": "..." }, ...] }`.
 * Anything else gives an empty list. Exported for direct unit testing.
 */
export function parseKiroModels(stdout: string): ModelInfo[] {
  try {
    const parsed = JSON.parse(stdout.trim()) as { models?: unknown }
    if (!Array.isArray(parsed.models)) return []
    const out: ModelInfo[] = []
    for (const m of parsed.models as Array<Record<string, unknown>>) {
      if (typeof m?.model_id !== 'string' || !m.model_id) continue
      out.push({
        id: m.model_id,
        ...(typeof m.model_name === 'string' && m.model_name ? { label: m.model_name } : {}),
        ...(typeof m.description === 'string' && m.description ? { note: m.description } : {})
      })
    }
    return out
  } catch {
    return []
  }
}
```

In `brains/index.ts` add `export { discoverModels, resetModelDiscoveryCache, STATIC_MODELS } from './model-discovery'` and change the Kiro export line to `export { KiroCliBrain, parseKiroOutput, parseKiroModels } from './kiro-cli-brain'`.

- [ ] **Step 8: Run the folder tests and the typecheck**

Run: `lowrun npx vitest run electron/main/services/brains` then `lowrun npm run typecheck:node`
Expected: PASS; no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/electron/electron/main/services/brains
git commit -m "Brains: list the models of each harness, cached, with timeouts and a built-in fallback"
```

---

### Task 6: Usage and cost for every harness

Today only Gemini calls record usage (`gemini-usage.ts`, 1,121 Gemini runs in 30 days had no cost until 29-sep-2026). This task adds a collector that any adapter can report to, with the same `AsyncLocalStorage` pattern, and makes the API and local adapters report. The CLI adapters follow in Task 7.

Scope: text calls. Embedding calls report nothing here: the runner of phase 2 times every call itself (spec section 9, step 8), and the embedding APIs of Gemini and the OpenAI protocol do not state tokens for a batch in the way the adapters read them. Audio stays on `gemini-usage.ts`, which the transcription stages already use.

**Files:**
- Create: `apps/electron/electron/main/services/brains/harness-usage.ts`
- Create: `apps/electron/electron/main/services/brains/__tests__/harness-usage.test.ts`
- Modify: `brains/gemini-api-brain.ts` (report next to `recordGeminiUsage`, twice)
- Modify: `brains/openai-compatible-brain.ts` (report tokens from `usage`)
- Modify: `apps/electron/electron/main/services/ollama.ts` (`chat` and `generate` take `model` and `onUsage`)
- Modify: `brains/ollama-brain.ts` (pass the model, report usage)
- Modify: tests `gemini-api-brain.test.ts`, `openai-compatible-brain.test.ts`, `ollama-brain.test.ts`
- Modify: `brains/index.ts`

**Interfaces:**
- Consumes: `costOf`, `tokensFromUsage`, `RunUsageFields` from `../gemini-usage`.
- Produces (Task 7 and the runner of phase 2 rely on these names):
  - `interface HarnessUsageReport { harness: string; model?: string; inputTokens?: number; outputTokens?: number; thinkingTokens?: number; cachedTokens?: number; durationMs: number; reportedCostUsd?: number | null }`
  - `recordHarnessUsage(report: HarnessUsageReport): void`
  - `createHarnessUsageCollector(): { run<T>(fn: () => T): T; total(): HarnessUsageTotal | null }`
  - `interface HarnessUsageTotal { calls: number; durationMs: number; inputTokens: number; outputTokens: number; thinkingTokens: number; cachedTokens: number; reportedCostUsd: number | null; byModel: Record<string, HarnessUsageBucket> }` where `HarnessUsageBucket` has `harness, model, calls, durationMs, inputTokens, outputTokens, thinkingTokens, cachedTokens, reportedCostUsd`
  - `harnessRunFields(total: HarnessUsageTotal | null, extra?: Record<string, unknown>, at?: Date): RunUsageFields`
  - `OllamaService.chat(messages, { model?, onUsage? })`, `OllamaService.generate(prompt, systemPrompt?, options?)`

- [ ] **Step 1: Write the failing collector test**

Create `apps/electron/electron/main/services/brains/__tests__/harness-usage.test.ts`:

```ts
/**
 * Usage of every harness, collected the way Gemini's already is: an async scope, no signature changes.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { createHarnessUsageCollector, harnessRunFields, recordHarnessUsage } from '../harness-usage'

describe('harness usage collector', () => {
  it('drops a report made outside any collector', () => {
    expect(() => recordHarnessUsage({ harness: 'ollama', durationMs: 5 })).not.toThrow()
  })

  it('counts calls, time and tokens per harness and model, across awaits', async () => {
    const collector = createHarnessUsageCollector()
    await collector.run(async () => {
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 1000, outputTokens: 200, thinkingTokens: 50, durationMs: 1500 })
      await new Promise((r) => setTimeout(r, 1))
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 500, outputTokens: 100, durationMs: 900 })
      recordHarnessUsage({ harness: 'ollama', model: 'qwen3:8b', durationMs: 4000 })
    })
    const total = collector.total()!
    expect(total.calls).toBe(3)
    expect(total.durationMs).toBe(6400)
    expect(total.inputTokens).toBe(1500)
    expect(total.outputTokens).toBe(300)
    expect(total.thinkingTokens).toBe(50)
    expect(Object.keys(total.byModel).sort()).toEqual(['gemini-api:gemini-3.8-flash', 'ollama:qwen3:8b'])
    expect(total.byModel['gemini-api:gemini-3.8-flash'].calls).toBe(2)
  })

  it('returns null when nothing was reported', () => {
    expect(createHarnessUsageCollector().total()).toBeNull()
  })

  it('goes to the innermost collector only, so a runner that opens one per call does not double count', () => {
    const outer = createHarnessUsageCollector()
    const inner = createHarnessUsageCollector()
    outer.run(() => {
      recordHarnessUsage({ harness: 'ollama', durationMs: 1 })
      inner.run(() => recordHarnessUsage({ harness: 'ollama', durationMs: 10 }))
    })
    expect(outer.total()!.durationMs).toBe(1)
    expect(inner.total()!.durationMs).toBe(10)
  })

  it('ignores garbage numbers instead of poisoning the total', () => {
    const collector = createHarnessUsageCollector()
    collector.run(() =>
      recordHarnessUsage({ harness: 'x', inputTokens: Number.NaN, outputTokens: -5, durationMs: Number.POSITIVE_INFINITY })
    )
    const total = collector.total()!
    expect(total.inputTokens).toBe(0)
    expect(total.outputTokens).toBe(0)
    expect(total.durationMs).toBe(0)
  })
})

describe('harnessRunFields', () => {
  it('prices Gemini by the list, takes the cost a CLI reports, and counts a local model as free', () => {
    const collector = createHarnessUsageCollector()
    collector.run(() => {
      recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-3.8-flash', inputTokens: 1_000_000, outputTokens: 1_000_000, durationMs: 1 })
      recordHarnessUsage({ harness: 'claude-code', model: 'claude-haiku-4-5-20251001', inputTokens: 1860, outputTokens: 45, reportedCostUsd: 0.002085, durationMs: 2094 })
      recordHarnessUsage({ harness: 'ollama', model: 'qwen3:8b', durationMs: 4000 })
    })
    const fields = harnessRunFields(collector.total(), { step: 'understand' }, new Date('2026-10-01T00:00:00Z'))
    // 0.75 + 3.75 for Gemini, 0.002085 reported by Claude Code, 0 for the local model.
    expect(fields.estimatedCostAmount).toBeCloseTo(4.502085, 6)
    expect(fields.estimatedCostCurrency).toBe('USD')
    expect(fields.usage).toMatchObject({ step: 'understand' })
    expect((fields.usage as { calls: number }).calls).toBe(3)
  })

  it('names the models it cannot price and leaves them out of the estimate', () => {
    const collector = createHarnessUsageCollector()
    collector.run(() => recordHarnessUsage({ harness: 'gemini-api', model: 'gemini-9-unlisted', inputTokens: 10, outputTokens: 10, durationMs: 1 }))
    const fields = harnessRunFields(collector.total())
    expect(fields.estimatedCostAmount).toBeNull()
    expect((fields.usage as { unpricedModels: string[] }).unpricedModels).toEqual(['gemini-api:gemini-9-unlisted'])
  })

  it('returns only the extra fields when nothing was reported', () => {
    expect(harnessRunFields(null)).toEqual({})
    expect(harnessRunFields(null, { a: 1 })).toEqual({ usage: { a: 1 } })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/harness-usage.test.ts`
Expected: FAIL, "Failed to resolve import '../harness-usage'".

- [ ] **Step 3: Write `harness-usage.ts`**

Create `apps/electron/electron/main/services/brains/harness-usage.ts`:

```ts
/**
 * What every harness call costs: tokens where the harness says them, time always, money where a
 * price is known.
 *
 * Same pattern as gemini-usage.ts (which stays: the transcription stages still use it): the code that
 * makes a call reports it with `recordHarnessUsage`, and the report goes to whichever collector is
 * active in that async context, or nowhere when there is none. A runner opens one collector per call
 * (`createHarnessUsageCollector().run(...)`), so a report goes to the innermost collector and is
 * never counted twice.
 *
 * Money: a price the harness itself reports (Claude Code's `total_cost_usd`) wins; Gemini is priced
 * by the list in gemini-usage.ts; a local harness costs nothing; anything else is named in
 * `unpricedModels` and adds nothing to the estimate, as gemini-usage does.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { costOf, type RunUsageFields } from '../gemini-usage'

export interface HarnessUsageReport {
  harness: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  thinkingTokens?: number
  cachedTokens?: number
  durationMs: number
  /** US dollars, when the harness reports its own cost. */
  reportedCostUsd?: number | null
}

export interface HarnessUsageBucket {
  harness: string
  model: string
  calls: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cachedTokens: number
  reportedCostUsd: number | null
}

export interface HarnessUsageTotal {
  calls: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cachedTokens: number
  reportedCostUsd: number | null
  byModel: Record<string, HarnessUsageBucket>
}

/** Harnesses that run on this machine: no money. */
const FREE_HARNESSES = new Set(['ollama', 'openai-compatible', 'local-onnx-embed'])

export const HARNESS_COST_METHOD = 'reported-or-list-price-2026-09-30'

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

const scopes = new AsyncLocalStorage<Map<string, HarnessUsageBucket>>()

export function recordHarnessUsage(report: HarnessUsageReport): void {
  const scope = scopes.getStore()
  if (!scope) return
  const model = report.model?.trim() || 'unknown'
  const key = `${report.harness}:${model}`
  const bucket = scope.get(key) ?? {
    harness: report.harness,
    model,
    calls: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedTokens: 0,
    reportedCostUsd: null
  }
  bucket.calls += 1
  bucket.durationMs += num(report.durationMs)
  bucket.inputTokens += num(report.inputTokens)
  bucket.outputTokens += num(report.outputTokens)
  bucket.thinkingTokens += num(report.thinkingTokens)
  bucket.cachedTokens += num(report.cachedTokens)
  if (typeof report.reportedCostUsd === 'number' && Number.isFinite(report.reportedCostUsd) && report.reportedCostUsd >= 0) {
    bucket.reportedCostUsd = (bucket.reportedCostUsd ?? 0) + report.reportedCostUsd
  }
  scope.set(key, bucket)
}

export interface HarnessUsageCollector {
  /** Runs `fn`; every report made inside it (however deep, however async) is counted here. */
  run: <T>(fn: () => T) => T
  /** What was counted, or null when nothing was. Readable after `fn` threw. */
  total: () => HarnessUsageTotal | null
}

export function createHarnessUsageCollector(): HarnessUsageCollector {
  const scope = new Map<string, HarnessUsageBucket>()
  return {
    run: (fn) => scopes.run(scope, fn),
    total: () => {
      if (scope.size === 0) return null
      const total: HarnessUsageTotal = {
        calls: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedTokens: 0,
        reportedCostUsd: null,
        byModel: {}
      }
      for (const [key, bucket] of scope) {
        total.calls += bucket.calls
        total.durationMs += bucket.durationMs
        total.inputTokens += bucket.inputTokens
        total.outputTokens += bucket.outputTokens
        total.thinkingTokens += bucket.thinkingTokens
        total.cachedTokens += bucket.cachedTokens
        if (bucket.reportedCostUsd !== null) total.reportedCostUsd = (total.reportedCostUsd ?? 0) + bucket.reportedCostUsd
        total.byModel[key] = { ...bucket }
      }
      return total
    }
  }
}

/** The fields a processing run stores for this usage: the numbers, and the cost estimate. */
export function harnessRunFields(
  total: HarnessUsageTotal | null,
  extra: Record<string, unknown> = {},
  at: Date = new Date()
): RunUsageFields {
  if (!total) return Object.keys(extra).length > 0 ? { usage: extra } : {}
  let cost = 0
  let priced = false
  const unpriced: string[] = []
  for (const [key, bucket] of Object.entries(total.byModel)) {
    if (bucket.reportedCostUsd !== null) {
      cost += bucket.reportedCostUsd
      priced = true
    } else if (FREE_HARNESSES.has(bucket.harness)) {
      priced = true
    } else if (bucket.harness === 'gemini-api' || bucket.harness === 'gemini-cli') {
      const c = costOf(
        bucket.model,
        { promptTokens: bucket.inputTokens, outputTokens: bucket.outputTokens, thoughtsTokens: bucket.thinkingTokens },
        at
      )
      if (c === null) unpriced.push(key)
      else {
        cost += c
        priced = true
      }
    } else {
      unpriced.push(key)
    }
  }
  return {
    usage: {
      ...extra,
      calls: total.calls,
      durationMs: total.durationMs,
      tokens: {
        input: total.inputTokens,
        output: total.outputTokens,
        thinking: total.thinkingTokens,
        cached: total.cachedTokens
      },
      byModel: total.byModel,
      ...(unpriced.length > 0 ? { unpricedModels: unpriced } : {})
    },
    estimatedCostAmount: priced ? Math.round(cost * 1e6) / 1e6 : null,
    estimatedCostCurrency: priced ? 'USD' : null,
    costMethod: priced ? HARNESS_COST_METHOD : null
  }
}
```

- [ ] **Step 4: Run the collector test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/harness-usage.test.ts`
Expected: PASS, 8 tests. In the pricing test the sum is 0.75 + 3.75 + 0.002085 = 4.502085.

- [ ] **Step 5: Write the failing adapter tests**

Append to `brains/__tests__/gemini-api-brain.test.ts` (`mockGenerateContent` and `mockGetSecret` exist at the top of the file):

```ts
describe('GeminiApiBrain reports harness usage', () => {
  it('reports tokens, model and time of generate and chat', async () => {
    mockGetSecret.mockReturnValue('k')
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => 'ok',
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 170 }
      }
    })
    const collector = createHarnessUsageCollector()
    const brain = new GeminiApiBrain()
    await collector.run(async () => {
      await brain.generate([{ role: 'user', content: 'a' }], { model: 'gemini-3.8-flash' })
      await brain.chat([{ role: 'user', content: 'b' }], { model: 'gemini-3.8-flash' })
    })
    const bucket = collector.total()!.byModel['gemini-api:gemini-3.8-flash']
    expect(bucket.calls).toBe(2)
    expect(bucket.inputTokens).toBe(240)
    expect(bucket.outputTokens).toBe(60)
    expect(bucket.thinkingTokens).toBe(40) // total 170 minus prompt 120 minus output 30, per call
  })
})
```

and add `import { createHarnessUsageCollector } from '../harness-usage'` to the imports of that file.

Append to `brains/__tests__/openai-compatible-brain.test.ts` (inside the file, using its `make`, `scriptedFetch`, `json` helpers):

```ts
describe('OpenAiCompatibleBrain reports harness usage', () => {
  it('reports the tokens the server states, under the model that answered', async () => {
    const f = scriptedFetch(() =>
      json({ choices: [{ message: { content: 'x' } }], model: 'qwen3-8b', usage: { prompt_tokens: 55, completion_tokens: 12 } })
    )
    const collector = createHarnessUsageCollector()
    await collector.run(() => make(f.fn).generate([{ role: 'user', content: 'hi' }]))
    const bucket = collector.total()!.byModel['openai-compatible:qwen3-8b']
    expect(bucket.inputTokens).toBe(55)
    expect(bucket.outputTokens).toBe(12)
    expect(bucket.calls).toBe(1)
  })

  it('reports the time even when the server states no usage', async () => {
    const f = scriptedFetch(() => json({ choices: [{ message: { content: 'x' } }] }))
    const collector = createHarnessUsageCollector()
    await collector.run(() => make(f.fn).generate([{ role: 'user', content: 'hi' }]))
    expect(collector.total()!.calls).toBe(1)
  })
})
```

with `import { createHarnessUsageCollector } from '../harness-usage'` added to that file's imports.

In `brains/__tests__/ollama-brain.test.ts`, change the existing assertion `expect(mockGenerate).toHaveBeenCalledWith('the prompt', 'sys')` to `expect(mockGenerate).toHaveBeenCalledWith('the prompt', 'sys', expect.objectContaining({ model: undefined }))` and add:

```ts
  it('passes the model of the call to Ollama, and reports the tokens Ollama states', async () => {
    mockChat.mockImplementation(async (_messages, options) => {
      options.onUsage?.({ inputTokens: 40, outputTokens: 8 })
      return 'answer'
    })
    const collector = createHarnessUsageCollector()
    const out = await collector.run(() => brain.chat([{ role: 'user', content: 'hi' }], { model: 'qwen3:8b' }))
    expect(out).toBe('answer')
    expect(mockChat).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: 'qwen3:8b' }))
    const bucket = collector.total()!.byModel['ollama:qwen3:8b']
    expect(bucket.inputTokens).toBe(40)
    expect(bucket.outputTokens).toBe(8)
  })
```

with `import { createHarnessUsageCollector } from '../harness-usage'` added.

- [ ] **Step 6: Run the adapter tests to verify they fail**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/gemini-api-brain.test.ts electron/main/services/brains/__tests__/openai-compatible-brain.test.ts electron/main/services/brains/__tests__/ollama-brain.test.ts`
Expected: FAIL on the new usage tests (no bucket).

- [ ] **Step 7: Make the adapters report**

`gemini-api-brain.ts`: import `import { recordHarnessUsage } from './harness-usage'` and `tokensFromUsage` next to `recordGeminiUsage` (`import { recordGeminiUsage, tokensFromUsage } from '../gemini-usage'`). Add a private helper at module level:

```ts
/** Reports one Gemini response to the harness collector (the Gemini one keeps its own report). */
function reportGeminiCall(modelId: string, usage: unknown, startedAt: number): void {
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
```

In `generate` and in `chat`, take `const startedAt = Date.now()` just before `model.generateContent(...)` and, on the line after `recordGeminiUsage(modelId, result.response.usageMetadata)`, add `reportGeminiCall(modelId, result.response.usageMetadata, startedAt)`.

`openai-compatible-brain.ts`: import `import { recordHarnessUsage } from './harness-usage'`; extend the `ChatCompletion` interface with `model?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }`; in `generate`, take `const startedAt = Date.now()` before the `post` call and, after the response is read and before the content check, add:

```ts
    if (data) {
      recordHarnessUsage({
        harness: this.id,
        model: (typeof data.model === 'string' && data.model) || model || undefined,
        inputTokens: typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : undefined,
        outputTokens: typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : undefined,
        durationMs: Date.now() - startedAt
      })
    }
```

`ollama.ts` (the service): extend `OllamaChatResponse` with `prompt_eval_count?: number; eval_count?: number`; extend the `chat` options with

```ts
      /** Model for this call. Defaults to the configured chat model. */
      model?: string
      /** Called with the token counts Ollama states for this call. */
      onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
```

use `model: options.model ?? this.chatModel` in the request body, and after `const data: OllamaChatResponse = await response.json()` add:

```ts
      if (options.onUsage && (data.prompt_eval_count !== undefined || data.eval_count !== undefined)) {
        options.onUsage({ inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 })
      }
```

and change `generate` to

```ts
  async generate(
    prompt: string,
    systemPrompt?: string,
    options: { model?: string; onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void } = {}
  ): Promise<string | null> {
    return this.chat([{ role: 'user', content: prompt }], { systemPrompt, ...options })
  }
```

`ollama-brain.ts`: import `recordHarnessUsage`; in `generate` and `chat`, wrap the call:

```ts
  async generate(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    const prompt = messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n')
    const systemPrompt = opts.systemPrompt ?? messages.find((m) => m.role === 'system')?.content
    const startedAt = Date.now()
    const usage = { inputTokens: undefined as number | undefined, outputTokens: undefined as number | undefined }
    const out = await getOllamaService().generate(prompt, systemPrompt, {
      model: opts.model,
      onUsage: (u) => Object.assign(usage, u)
    })
    recordHarnessUsage({ harness: this.id, model: opts.model, ...usage, durationMs: Date.now() - startedAt })
    return out
  }

  async chat(messages: BrainMessage[], opts: GenerateOptions = {}): Promise<string | null> {
    const startedAt = Date.now()
    const usage = { inputTokens: undefined as number | undefined, outputTokens: undefined as number | undefined }
    const out = await getOllamaService().chat(messages, {
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      model: opts.model,
      onUsage: (u) => Object.assign(usage, u)
    })
    recordHarnessUsage({ harness: this.id, model: opts.model, ...usage, durationMs: Date.now() - startedAt })
    return out
  }
```

In `brains/index.ts` add `export { recordHarnessUsage, createHarnessUsageCollector, harnessRunFields } from './harness-usage'` and `export type { HarnessUsageReport, HarnessUsageTotal, HarnessUsageBucket, HarnessUsageCollector } from './harness-usage'`.

- [ ] **Step 8: Run the folder tests, the Ollama service tests and the typecheck**

Run: `lowrun npx vitest run electron/main/services/brains electron/main/services/__tests__/ollama` then `lowrun npm run typecheck:node`
Expected: PASS; no type errors. If an `ollama` service test asserts the exact request body, add the `model` key it now carries.

- [ ] **Step 9: Commit**

```bash
git add apps/electron/electron/main/services/brains apps/electron/electron/main/services/ollama.ts apps/electron/electron/main/services/__tests__
git commit -m "Brains: usage, time and cost of every API and local call, and Ollama honours the model"
```

---

### Task 7: The CLI harnesses report usage, Claude Code answers in JSON, Kiro takes an effort

The four CLI adapters still return only text. This task makes each report time (always), tokens and money (where the CLI states them), and applies the two lean-invocation findings of 30-sep-2026: Claude Code prints a JSON result with usage and cost when asked with `--output-format json` (measured: 1,860 input tokens, 45 output of which 38 thinking, `total_cost_usd` 0.002085 for a one-word answer on Haiku at low effort), and `kiro-cli chat --effort low` is accepted (5 s a call, already at its floor with `--trust-tools=`). Codex states no usage on its plain output and its plan is out of quota until 4-oct-2026, so it reports time only.

**Files:**
- Modify: `brains/claude-code-brain.ts` (`LEAN_CLAUDE_ARGS`, `parseClaudeOutput`, `generate`)
- Modify: `brains/codex-brain.ts` (`generate`, time only)
- Modify: `brains/gemini-cli-brain.ts` (`parseGeminiUsage`, `generate`)
- Modify: `brains/kiro-cli-brain.ts` (`--effort`, `generate`, time only)
- Modify: `brains/__tests__/claude-code-brain.test.ts`, `codex-brain.test.ts`, `gemini-cli-brain.test.ts`, `kiro-cli-brain.test.ts`
- Modify: `brains/index.ts`

**Interfaces:**
- Consumes: `recordHarnessUsage`, `createHarnessUsageCollector` (Task 6); `makeFakeSpawn` from `__tests__/fake-spawn.ts`; `noteBrainFailure`, `isBrainCoolingDown`, `_resetBrainCooldownsForTests` from `brain-cooldown.ts`.
- Produces:
  - `parseClaudeOutput(stdout: string): ClaudeRun` with `interface ClaudeRun { text: string | null; isError: boolean; model?: string; inputTokens?: number; outputTokens?: number; thinkingTokens?: number; cachedTokens?: number; costUsd?: number }`
  - `parseGeminiUsage(stdout: string): { model?: string; inputTokens: number; outputTokens: number; thinkingTokens: number; cachedTokens: number } | null`
  - `LEAN_CLAUDE_ARGS` gains `--output-format json`.

- [ ] **Step 1: Write the failing Claude Code tests**

Append to `brains/__tests__/claude-code-brain.test.ts` (the file already imports `ClaudeCodeBrain`, `LEAN_CLAUDE_ARGS`, `makeFakeSpawn`; add `parseClaudeOutput` to the import from `../claude-code-brain`, and add `import { createHarnessUsageCollector } from '../harness-usage'` and `import { isBrainCoolingDown, _resetBrainCooldownsForTests } from '../brain-cooldown'`). The event shapes are the real ones printed by `claude -p --output-format json` 2.1.283:

```ts
const RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'OK',
  duration_ms: 2094,
  total_cost_usd: 0.002085,
  usage: {
    input_tokens: 1860,
    output_tokens: 45,
    cache_read_input_tokens: 12,
    output_tokens_details: { thinking_tokens: 38 }
  },
  modelUsage: { 'claude-haiku-4-5-20251001': {} }
}
const EVENTS = [
  { type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001' },
  { type: 'assistant', message: {} },
  RESULT_EVENT
]

describe('parseClaudeOutput', () => {
  it('reads the answer, tokens, cost and model from the result event of a JSON array', () => {
    expect(parseClaudeOutput(JSON.stringify(EVENTS))).toEqual({
      text: 'OK',
      isError: false,
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1860,
      outputTokens: 7, // 45 output tokens, 38 of them thinking
      thinkingTokens: 38,
      cachedTokens: 12,
      costUsd: 0.002085
    })
  })

  it('reads a single result object', () => {
    expect(parseClaudeOutput(JSON.stringify(RESULT_EVENT)).text).toBe('OK')
  })

  it('keeps plain text as the answer (an older CLI, or a test double)', () => {
    expect(parseClaudeOutput('  plain answer \n')).toEqual({ text: 'plain answer', isError: false })
  })

  it('does not mistake an answer that is itself valid JSON for the CLI envelope', () => {
    expect(parseClaudeOutput('42').text).toBe('42')
    expect(parseClaudeOutput('{"summary":"x"}').text).toBe('{"summary":"x"}')
    expect(parseClaudeOutput('[1,2,3]').text).toBe('[1,2,3]')
  })

  it('gives no answer for events without a result, and none for empty output', () => {
    expect(parseClaudeOutput(JSON.stringify(EVENTS.slice(0, 2)))).toEqual({ text: null, isError: false })
    expect(parseClaudeOutput('')).toEqual({ text: null, isError: false })
  })

  it('marks an error result as an error and keeps its message', () => {
    const errorEvent = { ...RESULT_EVENT, is_error: true, subtype: 'error_during_execution', result: 'Claude usage limit reached|1759000000' }
    const parsed = parseClaudeOutput(JSON.stringify([errorEvent]))
    expect(parsed.isError).toBe(true)
    expect(parsed.text).toBe('Claude usage limit reached|1759000000')
  })
})

describe('ClaudeCodeBrain reports usage and reads the JSON result', () => {
  afterEach(() => _resetBrainCooldownsForTests())

  it('asks for JSON on a text run and answers with the result text', async () => {
    const spawn = makeFakeSpawn({ stdout: JSON.stringify(EVENTS), code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: spawn.fn as never, env: {}, resolveCommand: async () => 'claude' })
    const collector = createHarnessUsageCollector()
    const out = await collector.run(() => brain.generate([{ role: 'user', content: 'q' }], { model: 'haiku' }))
    expect(out).toBe('OK')
    expect(spawn.calls[0].args).toContain('--output-format')
    expect(spawn.calls[0].args[spawn.calls[0].args.indexOf('--output-format') + 1]).toBe('json')
    const bucket = collector.total()!.byModel['claude-code:claude-haiku-4-5-20251001']
    expect(bucket).toMatchObject({ calls: 1, inputTokens: 1860, outputTokens: 7, thinkingTokens: 38, cachedTokens: 12, reportedCostUsd: 0.002085 })
    expect(Number.isFinite(bucket.durationMs)).toBe(true)
  })

  it('does not ask for JSON on an agentic run, and takes stdout as the answer', async () => {
    const spawn = makeFakeSpawn({ stdout: 'plain', code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: spawn.fn as never, env: {}, resolveCommand: async () => 'claude' })
    const collector = createHarnessUsageCollector()
    const out = await collector.run(() => brain.generate([{ role: 'user', content: 'q' }], { agentic: true, cwd: 'C:\\repo' }))
    expect(out).toBe('plain')
    expect(spawn.calls[0].args).not.toContain('--output-format')
    expect(collector.total()!.calls).toBe(1) // time only
  })

  it('treats an error result as a failure, not as an answer, and rests the brain when it is out of quota', async () => {
    const errorEvent = { ...RESULT_EVENT, is_error: true, result: 'Claude usage limit reached|1759000000' }
    const spawn = makeFakeSpawn({ stdout: JSON.stringify([errorEvent]), code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: spawn.fn as never, env: {}, resolveCommand: async () => 'claude' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await brain.generate([{ role: 'user', content: 'q' }])).toBeNull()
    expect(isBrainCoolingDown('claude-code')).toBe(true)
  })

  it('finds the out-of-quota message in the JSON of a failed run too', async () => {
    const errorEvent = { ...RESULT_EVENT, is_error: true, result: 'Claude usage limit reached|1759000000' }
    const spawn = makeFakeSpawn({ stdout: JSON.stringify([errorEvent]), stderr: '', code: 1 })
    const brain = new ClaudeCodeBrain({ spawn: spawn.fn as never, env: {}, resolveCommand: async () => 'claude' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await brain.generate([{ role: 'user', content: 'q' }])).toBeNull()
    expect(isBrainCoolingDown('claude-code')).toBe(true)
  })
})
```

If the file does not import `afterEach` or `vi` yet, add them to its `vitest` import line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/claude-code-brain.test.ts`
Expected: FAIL, "parseClaudeOutput is not a function".

- [ ] **Step 3: Implement the Claude Code changes**

In `brains/claude-code-brain.ts`:

1. Add `'--output-format', 'json',` to `LEAN_CLAUDE_ARGS` after `'--setting-sources=',` (before `'--system-prompt'`). Extend the comment above the constant with: `A text run asks for the JSON result: it carries the answer, the tokens and the cost the CLI states.`
2. Import `import { recordHarnessUsage } from './harness-usage'`.
3. Add, above the class:

```ts
export interface ClaudeRun {
  text: string | null
  isError: boolean
  model?: string
  inputTokens?: number
  outputTokens?: number
  thinkingTokens?: number
  cachedTokens?: number
  costUsd?: number
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Read `claude -p --output-format json`: an array of events ending in a `result` event (or that
 * event alone). Anything that is not that envelope is the answer itself: plain text from an older
 * CLI, or from an agentic run, or an answer that happens to be valid JSON. Exported for direct testing.
 */
export function parseClaudeOutput(stdout: string): ClaudeRun {
  const trimmed = stdout.trim()
  if (!trimmed) return { text: null, isError: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { text: trimmed, isError: false }
  }
  const events: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
  const result = [...events].reverse().find((e): e is Record<string, unknown> => isRecord(e) && e.type === 'result')
  if (!result) {
    // Events without a result (a run cut short) have no answer; anything else is the answer.
    const envelope = events.length > 0 && events.every((e) => isRecord(e) && typeof e.type === 'string')
    return envelope ? { text: null, isError: false } : { text: trimmed, isError: false }
  }
  const usage = isRecord(result.usage) ? result.usage : {}
  const thinking = asNumber(isRecord(usage.output_tokens_details) ? usage.output_tokens_details.thinking_tokens : undefined)
  const output = asNumber(usage.output_tokens)
  const init = events.find((e): e is Record<string, unknown> => isRecord(e) && e.type === 'system' && typeof e.model === 'string')
  const modelUsage = isRecord(result.modelUsage) ? Object.keys(result.modelUsage) : []
  const text = typeof result.result === 'string' && result.result.trim() ? result.result.trim() : null
  return {
    text,
    isError: result.is_error === true,
    model: modelUsage[0] ?? (init ? String(init.model) : undefined),
    inputTokens: asNumber(usage.input_tokens),
    // Claude Code counts thinking inside output_tokens; the collector keeps them apart.
    outputTokens: output === undefined ? undefined : Math.max(0, output - (thinking ?? 0)),
    thinkingTokens: thinking,
    cachedTokens: asNumber(usage.cache_read_input_tokens),
    costUsd: asNumber(result.total_cost_usd)
  }
}
```

4. In `generate`, take `const startedAt = Date.now()` before the first `runCli`, and replace the block from `if (res.code !== 0) {` to the end of the `try` body with:

```ts
      if (res.code !== 0) {
        // Only what the CLI reports as its error: a prompt it echoed may mention a
        // usage limit without the brain being out of quota. A JSON run states its error in
        // the result event on stdout, so that message counts too.
        const failure = summarizeCliFailure(res.stderr, res.code)
        console.error('[ClaudeCodeBrain] generate failed:', failure)
        const stated = agentic ? null : parseClaudeOutput(res.stdout)
        noteBrainFailure(this.id, stated?.isError && stated.text ? `${failure}\n${stated.text}` : failure)
        return null
      }
      const run: ClaudeRun = agentic ? { text: res.stdout.trim() || null, isError: false } : parseClaudeOutput(res.stdout)
      if (run.isError) {
        console.error('[ClaudeCodeBrain] generate ended with an error result')
        noteBrainFailure(this.id, run.text ?? '')
        return null
      }
      recordHarnessUsage({
        harness: this.id,
        model: run.model ?? opts.model,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        thinkingTokens: run.thinkingTokens,
        cachedTokens: run.cachedTokens,
        reportedCostUsd: run.costUsd,
        durationMs: Date.now() - startedAt
      })
      return run.text
```

5. In `brains/index.ts` change the Claude export to `export { ClaudeCodeBrain, resolveClaudeCommand, parseClaudeOutput } from './claude-code-brain'`.

- [ ] **Step 4: Run the Claude tests to verify they pass**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/claude-code-brain.test.ts`
Expected: PASS. The existing tests assert `['-p', ...LEAN_CLAUDE_ARGS]` through the constant, so they follow the new flag; their plain-text stdout takes the fallback path.

- [ ] **Step 5: Write the failing tests for Codex, Gemini CLI and Kiro**

Append to `brains/__tests__/codex-brain.test.ts` (add `createHarnessUsageCollector` import):

```ts
describe('CodexBrain reports usage', () => {
  it('reports the time of a call (Codex states no usage on its plain output)', async () => {
    const spawn = makeFakeSpawn({ stdout: 'ok', code: 0 })
    const brain = new CodexBrain({ spawn: spawn.fn as never, env: {} })
    const collector = createHarnessUsageCollector()
    await collector.run(() => brain.generate([{ role: 'user', content: 'q' }], { model: 'gpt-x' }))
    const bucket = collector.total()!.byModel['codex:gpt-x']
    expect(bucket.calls).toBe(1)
    expect(bucket.inputTokens).toBe(0)
    expect(Number.isFinite(bucket.durationMs)).toBe(true)
  })
})
```

Append to `brains/__tests__/gemini-cli-brain.test.ts` (add `parseGeminiUsage` to the import from `../gemini-cli-brain`, and the collector import):

```ts
describe('Gemini CLI usage', () => {
  const envelope = {
    response: 'OK',
    stats: { models: { 'gemini-3.8-flash': { tokens: { prompt: 900, candidates: 40, thoughts: 25, cached: 100, total: 965 } } } }
  }

  it('reads the tokens the CLI states in its stats', () => {
    expect(parseGeminiUsage(JSON.stringify(envelope))).toEqual({
      model: 'gemini-3.8-flash',
      inputTokens: 900,
      outputTokens: 40,
      thinkingTokens: 25,
      cachedTokens: 100
    })
  })

  it('reads nothing from output without stats, or that is not JSON', () => {
    expect(parseGeminiUsage('{"response":"x"}')).toBeNull()
    expect(parseGeminiUsage('plain')).toBeNull()
    expect(parseGeminiUsage('')).toBeNull()
  })

  it('reports tokens when there are stats, and time when there are none', async () => {
    const withStats = makeFakeSpawn({ stdout: JSON.stringify(envelope), code: 0 })
    const collector = createHarnessUsageCollector()
    const brain = new GeminiCliBrain({ spawn: withStats.fn as never, env: { GEMINI_API_KEY: 'x' }, hasOAuthLogin: () => false })
    expect(await collector.run(() => brain.generate([{ role: 'user', content: 'q' }]))).toBe('OK')
    expect(collector.total()!.byModel['gemini-cli:gemini-3.8-flash']).toMatchObject({ calls: 1, inputTokens: 900, outputTokens: 40 })

    const noStats = makeFakeSpawn({ stdout: '{"response":"OK"}', code: 0 })
    const second = createHarnessUsageCollector()
    const brain2 = new GeminiCliBrain({ spawn: noStats.fn as never, env: { GEMINI_API_KEY: 'x' }, hasOAuthLogin: () => false })
    await second.run(() => brain2.generate([{ role: 'user', content: 'q' }], { model: 'gemini-3.8-flash' }))
    expect(second.total()!.byModel['gemini-cli:gemini-3.8-flash'].calls).toBe(1)
  })
})
```

Append to `brains/__tests__/kiro-cli-brain.test.ts` (add the collector import):

```ts
describe('Kiro effort and usage', () => {
  it('passes the effort with a fixed flag', async () => {
    const spawn = makeFakeSpawn({ stdout: '> OK', code: 0 })
    const brain = new KiroCliBrain({ spawn: spawn.fn as never, env: {}, getStoredKey: () => '' })
    await brain.generate([{ role: 'user', content: 'q' }], { effort: 'low' })
    const args = spawn.calls[0].args
    expect(args).toEqual(['chat', '--no-interactive', '--trust-tools=', '--effort', 'low'])
    expect(args.join(' ')).not.toContain('q')
  })

  it('reports the time of a call', async () => {
    const spawn = makeFakeSpawn({ stdout: '> OK', code: 0 })
    const brain = new KiroCliBrain({ spawn: spawn.fn as never, env: {}, getStoredKey: () => '' })
    const collector = createHarnessUsageCollector()
    await collector.run(() => brain.generate([{ role: 'user', content: 'q' }]))
    expect(collector.total()!.byModel['kiro:unknown'].calls).toBe(1)
  })
})
```

- [ ] **Step 6: Run the three test files to verify they fail**

Run: `lowrun npx vitest run electron/main/services/brains/__tests__/codex-brain.test.ts electron/main/services/brains/__tests__/gemini-cli-brain.test.ts electron/main/services/brains/__tests__/kiro-cli-brain.test.ts`
Expected: FAIL (no bucket, `parseGeminiUsage` missing, argv lacks `--effort`).

- [ ] **Step 7: Implement Codex, Gemini CLI and Kiro**

`codex-brain.ts`: import `recordHarnessUsage`; take `const startedAt = Date.now()` before `runCli`; after the `res.code !== 0` block and before `const text = ...`:

```ts
      recordHarnessUsage({ harness: this.id, model: opts.model, durationMs: Date.now() - startedAt })
```

`kiro-cli-brain.ts`: import `recordHarnessUsage`; after `if (opts.model) args.push('--model', opts.model)` add

```ts
    if (opts.effort) args.push('--effort', opts.effort)
```

take `const startedAt = Date.now()` before `runCli`; after the `res.code !== 0` block and before `return parseKiroOutput(res.stdout)`:

```ts
      recordHarnessUsage({ harness: this.id, model: opts.model, durationMs: Date.now() - startedAt })
```

`gemini-cli-brain.ts`: import `recordHarnessUsage`; add above the class:

```ts
export interface GeminiCliUsage {
  model?: string
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cachedTokens: number
}

const stat = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * The tokens `gemini --output-format json` states in `stats.models.<model>.tokens`. Summed over the
 * models it used (routing may use two) and attributed to the first. Null when the output has no stats.
 * Exported for direct unit testing.
 */
export function parseGeminiUsage(stdout: string): GeminiCliUsage | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { stats?: { models?: Record<string, { tokens?: Record<string, unknown> }> } }
    const models = parsed.stats?.models
    if (!models || typeof models !== 'object') return null
    const usage: GeminiCliUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0 }
    for (const [name, m] of Object.entries(models)) {
      const t = m?.tokens ?? {}
      usage.model ??= name
      usage.inputTokens += stat(t.prompt ?? t.input)
      usage.outputTokens += stat(t.candidates ?? t.output)
      usage.thinkingTokens += stat(t.thoughts)
      usage.cachedTokens += stat(t.cached)
    }
    return usage.model ? usage : null
  } catch {
    return null
  }
}
```

take `const startedAt = Date.now()` before `runCli`; after the `res.code !== 0` block and before `return parseGeminiJson(res.stdout)`:

```ts
      const usage = parseGeminiUsage(res.stdout)
      recordHarnessUsage({
        harness: this.id,
        model: usage?.model ?? opts.model,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        thinkingTokens: usage?.thinkingTokens,
        cachedTokens: usage?.cachedTokens,
        durationMs: Date.now() - startedAt
      })
```

In `brains/index.ts`: `export { GeminiCliBrain, parseGeminiJson, parseGeminiUsage } from './gemini-cli-brain'`.

- [ ] **Step 8: Run the folder tests and the typecheck**

Run: `lowrun npx vitest run electron/main/services/brains` then `lowrun npm run typecheck:node`
Expected: PASS; no type errors.

- [ ] **Step 9: Measure the Gemini CLI lean flags (needs a key in the shell)**

The Gemini CLI answers only with `GEMINI_API_KEY` in the environment on this machine (measured 30-sep-2026: without it every variant exits 41). An agent must not copy the owner's stored key into a shell. If the implementer has no key of their own, skip this step, keep `gemini-cli-brain.ts` as it is, and write "Gemini CLI lean flags: unmeasured, no key available" in the PR description. With a key, create `measure-gemini.sh` in the session scratch folder:

```bash
#!/usr/bin/env bash
# Times the Gemini CLI on a one-word answer: default against candidate lean flags.
cd "$(mktemp -d)"
run() {
  local label="$1"; shift
  local start=$(date +%s)
  echo "Answer with the single word OK" | timeout 120 gemini "$@" > "gm-$label.txt"
  local code=$?
  echo "$label exit=$code seconds=$(( $(date +%s) - start ))"
  head -c 300 "gm-$label.txt"; echo
}
run default -p "" --output-format json
run ext-none -p "" --output-format json -e none
run ext-mcp-none -p "" --output-format json -e none --allowed-mcp-server-names none
run plan -p "" --output-format json -e none --allowed-mcp-server-names none --approval-mode plan
```

Run it three times with `lowrun bash measure-gemini.sh` (no stderr redirection; it appears in the tool output). Rule: adopt a variant's flags into `gemini-cli-brain.ts` (after `--output-format json`, for non-agentic runs only, the same way Claude's are gated on `opts.agentic`) only when it answered `OK` every time and took at least 20% less than `default` in the median of the three runs. Adopting flags adds a test that asserts the exact argv for a text run and for an `agentic: true` run, and the numbers go in the commit message. If no variant qualifies, change nothing and say so in the PR description.

- [ ] **Step 10: Commit**

```bash
git add apps/electron/electron/main/services/brains
git commit -m "Brains: the CLI harnesses report time and, where they state them, tokens and cost; Claude Code answers in JSON; Kiro takes an effort"
```

---

### Task 8: The structured-output contract and one JSON repair

Spec section 6, rule 2: a task has a schema; the adapter uses the native mode where there is one, otherwise the schema goes in the prompt; a lenient parser reads the answer; if it fails, one repair call by a cheap profile fixes the JSON. `repairJsonString` lives today inside `transcription.ts`, a 3,000-line module that pulls Electron in. This task moves it to a pure module and builds the contract on it. Nothing calls the contract yet (phase 2 does).

**Files:**
- Create: `apps/electron/electron/main/services/pipeline/json-repair.ts` (moved, unchanged behaviour)
- Create: `apps/electron/electron/main/services/pipeline/structured-output.ts`
- Create: `apps/electron/electron/main/services/pipeline/__tests__/structured-output.test.ts`
- Modify: `apps/electron/electron/main/services/transcription.ts` (remove the function body, import and re-export it)

**Interfaces:**
- Consumes: `zod` (`import { z } from 'zod'`).
- Produces:
  - `repairJsonString(input: string): string` (same file content as before, new home)
  - `interface Contract<T> { name: string; schema: z.ZodType<T>; example: string }`
  - `defineContract<T>(name: string, schema: z.ZodType<T>, example: unknown): Contract<T>`
  - `schemaInstruction(contract: Contract<unknown>): string`
  - `type ContractFailureReason = 'empty' | 'no-json' | 'invalid-json' | 'schema-mismatch'`
  - `class ContractError extends Error { reason: ContractFailureReason; rawLength: number; issuePaths: string[] }`
  - `extractJsonText(raw: string): string | null`
  - `parseWithContract<T>(contract: Contract<T>, raw: string): { ok: true; value: T; repaired: boolean } | { ok: false; error: ContractError }`
  - `runContract<T>(args: { contract: Contract<T>; call: () => Promise<string | null>; repair?: (raw: string, error: ContractError) => Promise<string | null> }): Promise<{ ok: true; value: T; repairedBy: 'parser' | 'call' | null } | { ok: false; error: ContractError }>`

- [ ] **Step 1: Move `repairJsonString` without changing it**

In `transcription.ts` find the JSDoc block that starts `Repair the two malformations Gemini's JSON-mode reliably produces` and the `export function repairJsonString(input: string): string { ... }` that follows (about lines 1660 to 1780; it ends at the closing brace before the next top-level declaration). Cut both, paste them unchanged into `pipeline/json-repair.ts` under a two-line header comment ("Pure JSON repair for model output. Moved out of transcription.ts so the structured-output contract can use it without pulling Electron in."), and in `transcription.ts` put in their place:

```ts
import { repairJsonString } from './pipeline/json-repair'
export { repairJsonString }
```

(the import goes with the other imports at the top of the file; the re-export keeps the existing tests and callers working).

Run: `lowrun npx vitest run electron/main/services/__tests__/transcription` (every existing test that touches `repairJsonString` must still pass unchanged) and `lowrun npm run typecheck:node`.
Expected: PASS, no type errors.

- [ ] **Step 2: Write the failing contract test**

Create `apps/electron/electron/main/services/pipeline/__tests__/structured-output.test.ts`:

```ts
/**
 * The structured-output contract: extract JSON from a model answer, repair what can be repaired, check
 * the shape, ask for one repair call at most, and fail with a reason that carries no content.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  ContractError,
  defineContract,
  extractJsonText,
  parseWithContract,
  runContract,
  schemaInstruction
} from '../structured-output'
import { repairJsonString } from '../json-repair'

const summary = defineContract(
  'summary',
  z.object({ summary: z.string().min(1), topics: z.array(z.string()) }),
  { summary: 'Two sentences.', topics: ['budget'] }
)

describe('repairJsonString (moved)', () => {
  it('still escapes inner quotes and drops a trailing comma', () => {
    expect(JSON.parse(repairJsonString('{"a": "dijo "no" y", "b": [1,],}'))).toEqual({ a: 'dijo "no" y', b: [1] })
  })
})

describe('extractJsonText', () => {
  it('finds the JSON in a code fence and in prose', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJsonText('Here you go:\n{"a":1}\nHope it helps')).toBe('{"a":1}\nHope it helps')
    expect(extractJsonText('[1,2]')).toBe('[1,2]')
  })

  it('gives null when there is no JSON', () => {
    expect(extractJsonText('I cannot do that.')).toBeNull()
    expect(extractJsonText('   ')).toBeNull()
  })
})

describe('parseWithContract', () => {
  it('accepts a valid answer', () => {
    const r = parseWithContract(summary, '{"summary":"ok","topics":["a"]}')
    expect(r).toEqual({ ok: true, value: { summary: 'ok', topics: ['a'] }, repaired: false })
  })

  it('accepts an answer in a fence with prose around it', () => {
    const r = parseWithContract(summary, 'Sure!\n```json\n{"summary":"ok","topics":[]}\n```\nAnything else?')
    expect(r.ok).toBe(true)
  })

  it('repairs unescaped inner quotes, a wrong closer and trailing text, and says it did', () => {
    const r = parseWithContract(summary, '{"summary":"dijo "no" y se fue","topics":["a"]] trailing words')
    expect(r).toEqual({ ok: true, value: { summary: 'dijo "no" y se fue', topics: ['a'] }, repaired: true })
  })

  it('fails with no-json for prose, and empty for nothing', () => {
    const prose = parseWithContract(summary, 'I cannot help with that.')
    expect(prose.ok).toBe(false)
    if (!prose.ok) expect(prose.error.reason).toBe('no-json')
    const nothing = parseWithContract(summary, '  ')
    if (!nothing.ok) expect(nothing.error.reason).toBe('empty')
  })

  it('fails with schema-mismatch when the shape is wrong, naming the fields and never the content', () => {
    const r = parseWithContract(summary, '{"summary":"","topics":"budget","secret":"PRIVATE-TEXT"}')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.reason).toBe('schema-mismatch')
    expect(r.error.issuePaths.sort()).toEqual(['summary', 'topics'])
    expect(r.error.message).not.toContain('PRIVATE-TEXT')
    expect(r.error.rawLength).toBeGreaterThan(0)
  })

  it('never returns a half-filled object for a truncated answer: the closers are added, the shape check refuses it', () => {
    const r = parseWithContract(summary, '{"summary":"ok"')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(ContractError)
    expect(r.error.reason).toBe('schema-mismatch')
    expect(r.error.issuePaths).toEqual(['topics'])
  })
})

describe('schemaInstruction', () => {
  it('shows the model the shape by example and asks for JSON only', () => {
    const text = schemaInstruction(summary)
    expect(text).toContain('only JSON')
    expect(text).toContain('"summary": "Two sentences."')
  })
})

describe('runContract', () => {
  it('returns a valid first answer without asking for a repair', async () => {
    const repair = vi.fn()
    const r = await runContract({ contract: summary, call: async () => '{"summary":"ok","topics":[]}', repair })
    expect(r).toEqual({ ok: true, value: { summary: 'ok', topics: [] }, repairedBy: null })
    expect(repair).not.toHaveBeenCalled()
  })

  it('says the parser repaired it when the parser did', async () => {
    const r = await runContract({ contract: summary, call: async () => '{"summary":"a "b" c","topics":[],}' })
    expect(r).toMatchObject({ ok: true, repairedBy: 'parser' })
  })

  it('asks for one repair when the answer is unusable, and uses it', async () => {
    const repair = vi.fn(async () => '{"summary":"fixed","topics":["x"]}')
    const r = await runContract({ contract: summary, call: async () => 'no json here', repair })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair.mock.calls[0][0]).toBe('no json here')
    expect(repair.mock.calls[0][1]).toBeInstanceOf(ContractError)
    expect(r).toEqual({ ok: true, value: { summary: 'fixed', topics: ['x'] }, repairedBy: 'call' })
  })

  it('asks at most once, and returns the reason of the second failure', async () => {
    const repair = vi.fn(async () => '{"summary":"","topics":[]}')
    const r = await runContract({ contract: summary, call: async () => 'nope', repair })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('schema-mismatch')
  })

  it('does not ask for a repair when the call gave nothing, and fails as empty', async () => {
    const repair = vi.fn()
    const r = await runContract({ contract: summary, call: async () => null, repair })
    expect(repair).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('empty')
  })

  it('fails without a repair function, and when the repair call gives nothing', async () => {
    const noRepair = await runContract({ contract: summary, call: async () => 'nope' })
    expect(noRepair.ok).toBe(false)
    const emptyRepair = await runContract({ contract: summary, call: async () => 'nope', repair: async () => null })
    expect(emptyRepair.ok).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/structured-output.test.ts`
Expected: FAIL, "Failed to resolve import '../structured-output'".

- [ ] **Step 4: Write `structured-output.ts`**

Create `apps/electron/electron/main/services/pipeline/structured-output.ts`:

```ts
/**
 * Structured output as a contract, not a prompt habit (pipeline design, section 6, rule 2).
 *
 * A task defines a contract: a name, a zod schema and an example. The runner asks a harness in its
 * native structured mode where it has one; otherwise it appends `schemaInstruction(contract)` to the
 * prompt. Either way the answer comes back here: the JSON is found in whatever surrounds it, repaired
 * by `repairJsonString` if it does not parse, and checked against the schema. If that fails, ONE repair
 * call (a cheap profile asked to fix the JSON) is allowed, and then the step fails with a reason.
 *
 * A failure never carries content: it names the reason, the length of the raw answer and the fields
 * that failed, so it can go in a log and in a processing run. The answer may be a private transcript.
 */
import { z } from 'zod'
import { repairJsonString } from './json-repair'

export interface Contract<T> {
  name: string
  schema: z.ZodType<T>
  /** JSON shown to a model that has no native structured mode. */
  example: string
}

export function defineContract<T>(name: string, schema: z.ZodType<T>, example: unknown): Contract<T> {
  return { name, schema, example: JSON.stringify(example, null, 2) }
}

/** The sentence-and-example a prompt carries when the harness cannot enforce a schema itself. */
export function schemaInstruction(contract: Contract<unknown>): string {
  return `Reply with only JSON, no other text, in exactly this shape (the values are examples):\n${contract.example}`
}

export type ContractFailureReason = 'empty' | 'no-json' | 'invalid-json' | 'schema-mismatch'

export class ContractError extends Error {
  constructor(
    readonly reason: ContractFailureReason,
    readonly rawLength: number,
    readonly issuePaths: string[] = []
  ) {
    super(
      `structured output failed: ${reason}` +
        (issuePaths.length > 0 ? ` (${issuePaths.join(', ')})` : '') +
        ` [${rawLength} characters]`
    )
    this.name = 'ContractError'
  }
}

/**
 * The JSON of a model answer: what follows the first `{` or `[`, code fences removed. Trailing prose
 * stays on the end; the repair pass drops anything after the root value closes. Null when there is none.
 */
export function extractJsonText(raw: string): string | null {
  const unfenced = raw.replace(/```(?:json|JSON)?/g, '')
  const start = unfenced.search(/[{[]/)
  if (start < 0) return null
  return unfenced.slice(start).trim()
}

export type ParseResult<T> = { ok: true; value: T; repaired: boolean } | { ok: false; error: ContractError }

export function parseWithContract<T>(contract: Contract<T>, raw: string): ParseResult<T> {
  if (!raw.trim()) return { ok: false, error: new ContractError('empty', raw.length) }
  const text = extractJsonText(raw)
  if (text === null) return { ok: false, error: new ContractError('no-json', raw.length) }

  let value: unknown
  let repaired = false
  try {
    value = JSON.parse(text)
  } catch {
    try {
      value = JSON.parse(repairJsonString(text))
      repaired = true
    } catch {
      return { ok: false, error: new ContractError('invalid-json', raw.length) }
    }
  }

  const checked = contract.schema.safeParse(value)
  if (!checked.success) {
    // Paths only: an issue message can echo a value from the answer.
    const paths = [...new Set(checked.error.issues.map((i) => i.path.join('.') || '(root)'))]
    return { ok: false, error: new ContractError('schema-mismatch', raw.length, paths) }
  }
  return { ok: true, value: checked.data, repaired }
}

export type ContractRun<T> =
  | { ok: true; value: T; repairedBy: 'parser' | 'call' | null }
  | { ok: false; error: ContractError }

/**
 * Call a harness, read its answer against the contract, and repair at most once.
 * `repair` receives the raw answer and the reason; it returns a new raw answer, or null.
 */
export async function runContract<T>(args: {
  contract: Contract<T>
  call: () => Promise<string | null>
  repair?: (raw: string, error: ContractError) => Promise<string | null>
}): Promise<ContractRun<T>> {
  const raw = await args.call()
  if (raw === null || !raw.trim()) return { ok: false, error: new ContractError('empty', raw?.length ?? 0) }

  const first = parseWithContract(args.contract, raw)
  if (first.ok) return { ok: true, value: first.value, repairedBy: first.repaired ? 'parser' : null }
  if (!args.repair) return first

  const fixed = await args.repair(raw, first.error)
  if (fixed === null || !fixed.trim()) return first
  const second = parseWithContract(args.contract, fixed)
  return second.ok ? { ok: true, value: second.value, repairedBy: 'call' } : second
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/structured-output.test.ts`
Expected: PASS, 16 tests. If the repaired-quotes case fails because `repairJsonString` treats the inner quotes differently, keep the function unchanged (its behaviour is the specification, proven by its own tests) and adjust the input of the test to one the function repairs; do not edit the function.

- [ ] **Step 6: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (no errors), then:

```bash
git add apps/electron/electron/main/services/pipeline apps/electron/electron/main/services/transcription.ts
git commit -m "Pipeline: a structured-output contract with one JSON repair, and repairJsonString in its own module"
```

---

### Task 9: Jev as a harness

Jev is called through `askJev` in three places (value, meeting match, speaker names). It is not a text generator, so it is not an `AIBrain`; it is a harness with a descriptor and an `ask()` that reports usage, so the runner of phase 2 can treat it like the others.

**Files:**
- Create: `apps/electron/electron/main/services/pipeline/jev-harness.ts`
- Create: `apps/electron/electron/main/services/pipeline/__tests__/jev-harness.test.ts`

**Interfaces:**
- Consumes: `askJev`, `JevError`, `JEV_MODEL`, `JevQuestion`, `JevResponse`, `JevStructured` from `../jev-client`; `jevKeyFor`, `JevJob` from `../jev-settings`; `JEV_DESCRIPTOR` (Task 4); `recordHarnessUsage`, `createHarnessUsageCollector` (Task 6).
- Produces:
  - `interface JevHarness { descriptor: HarnessDescriptor; isConfigured(): boolean; ask(state: JevStructured, questions: Record<string, JevQuestion>, opts?: AskJevOptions): Promise<JevResponse> }`
  - `createJevHarness(deps: { getKey: () => string | null; askImpl?: typeof askJev }): JevHarness`
  - `jevHarnessFor(job: JevJob): JevHarness` (the key of that job's switches)

- [ ] **Step 1: Write the failing test**

Create `apps/electron/electron/main/services/pipeline/__tests__/jev-harness.test.ts`:

```ts
/**
 * Jev behind the same face as the other harnesses: a descriptor, a configured check, usage reported.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { createJevHarness } from '../jev-harness'
import { JevError, type JevResponse } from '../../jev-client'
import { createHarnessUsageCollector } from '../../brains/harness-usage'
import { JEV_DESCRIPTOR } from '../../brains/engine-descriptors'

const RESPONSE: JevResponse = {
  model: 'jev-latest',
  answers: { q: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 420, output_tokens: 6 }
}

describe('createJevHarness', () => {
  it('carries the Jev descriptor', () => {
    expect(createJevHarness({ getKey: () => 'k' }).descriptor).toBe(JEV_DESCRIPTOR)
  })

  it('is configured only with a key', () => {
    expect(createJevHarness({ getKey: () => 'k' }).isConfigured()).toBe(true)
    expect(createJevHarness({ getKey: () => null }).isConfigured()).toBe(false)
    expect(createJevHarness({ getKey: () => '  ' }).isConfigured()).toBe(false)
  })

  it('asks Jev with the key and reports the tokens and the time', async () => {
    const askImpl = vi.fn(async () => RESPONSE)
    const harness = createJevHarness({ getKey: () => 'key-1', askImpl })
    const collector = createHarnessUsageCollector()
    const out = await collector.run(() => harness.ask('state', { q: { type: 'noul', instructions: 'yes or no?' } }))
    expect(out).toBe(RESPONSE)
    expect(askImpl).toHaveBeenCalledWith('key-1', 'state', { q: { type: 'noul', instructions: 'yes or no?' } }, {})
    const bucket = collector.total()!.byModel['jev:jev-latest']
    expect(bucket).toMatchObject({ calls: 1, inputTokens: 420, outputTokens: 6 })
  })

  it('refuses to call without a key, with an error that names no key', async () => {
    const askImpl = vi.fn()
    const harness = createJevHarness({ getKey: () => null, askImpl })
    await expect(harness.ask('s', {})).rejects.toBeInstanceOf(JevError)
    expect(askImpl).not.toHaveBeenCalled()
  })

  it('lets the error of a failed call through and reports nothing for it', async () => {
    const askImpl = vi.fn(async () => {
      throw new JevError('Jev returned HTTP 429', 429)
    })
    const collector = createHarnessUsageCollector()
    const harness = createJevHarness({ getKey: () => 'k', askImpl })
    await expect(collector.run(() => harness.ask('s', {}))).rejects.toMatchObject({ status: 429 })
    expect(collector.total()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/jev-harness.test.ts`
Expected: FAIL, "Failed to resolve import '../jev-harness'".

- [ ] **Step 3: Write `jev-harness.ts`**

Create `apps/electron/electron/main/services/pipeline/jev-harness.ts`:

```ts
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
import { jevKeyFor, type JevJob } from '../jev-settings'
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
      recordHarnessUsage({
        harness: 'jev',
        model: response.model || JEV_MODEL,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs: Date.now() - startedAt
      })
      return response
    }
  }
}

/** The Jev harness with the key of one job: it is configured only when Jev and that job's switch are on. */
export function jevHarnessFor(job: JevJob): JevHarness {
  return createJevHarness({ getKey: () => jevKeyFor(job) })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `lowrun npx vitest run electron/main/services/pipeline/__tests__/jev-harness.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `lowrun npm run typecheck:node` (no errors), then:

```bash
git add apps/electron/electron/main/services/pipeline
git commit -m "Pipeline: Jev behind a descriptor and an ask() that reports usage"
```

---

### Task 10: Verification, documents and delivery

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-pipeline-design.md` (status line, section 13)
- Modify: `docs/superpowers/specs/2026-09-30-pipeline-design-inventory.md` (the harness list)

- [ ] **Step 1: Update the design documents**

In the design, change the status line to say phase 0 and phase 1 are built and name the pull requests, and in the phases table of section 13 mark phase 1 "Built (PR #N)" with the number of the pull request that carries this plan. In the inventory add, under its brains section, one line: "Harnesses as of phase 1: eight brains (`openai-compatible` added), six audio engines and Jev described in `brains/descriptor.ts`, `brains/engine-descriptors.ts` and listed by `brains/harness-catalog.ts`."

- [ ] **Step 2: Run everything, one command at a time**

Run each with `lowrun`, from `apps/electron`: `npm run typecheck`, `npx eslint electron`, `npx vitest run` (the whole suite; it takes about two minutes and must be the only heavy job running).
Expected: no type errors, no lint output, every test passing (the count is 523 files and 6,755 tests at the start of this plan, plus the new ones).

- [ ] **Step 3: Secret gate, then push**

Run the secret gate from the Global Constraints as its own command and expect no output. Then check the account (`gh auth status --active` must show `sgeraldes`; if it shows the other account run `gh auth switch --user sgeraldes` as its own command) and push the branch.

- [ ] **Step 4: Adversarial review by a separate agent**

From the repository root, with the prompt in a file so it never passes through the shell as an argument list:

```bash
timeout 900 "/c/Users/Sebastian/AppData/Local/Kiro-Cli/run/chat-cli-2.24.1.exe" chat --no-interactive --trust-tools=fs_read,execute_bash "$(cat review-prompt.txt)" > kiro-out.txt
```

Write `review-prompt.txt` in the session scratch folder with this text, replacing `<BRANCH>` with the branch and `<FINDINGS FILE>` with an absolute path in the same folder:

```text
Review the commits of branch <BRANCH> against main (git log main..HEAD, git diff main...HEAD). Bugs only, no style. Time cap 10 minutes; write your findings file EARLY and update it as you go.

Context: pipeline phase 1 (docs/superpowers/specs/2026-09-30-pipeline-design.md, docs/superpowers/plans/2026-09-30-pipeline-phase-1-harnesses.md). Check: (a) brains/descriptor.ts and the descriptor() of every adapter: values against what the adapter really does, the fallback for a brain without one; (b) brains/openai-compatible-brain.ts against a dead, slow, lying and partially answering server: no throw, right lengths from embed, no prompt in a log or URL, the key only in a header, abort handling, the loopback rule; (c) brains/model-discovery.ts: timeouts, in-flight sharing, the failure cache, the last-good fallback; (d) brains/harness-usage.ts: scope nesting, garbage numbers, the price rules in harnessRunFields; (e) claude-code-brain.ts parseClaudeOutput and generate: an answer that is itself valid JSON, events without a result, an error result with exit 0 and with exit 1, the quota message reaching brain-cooldown, the agentic path staying plain text; usage reporting in every adapter; (f) pipeline/structured-output.ts and json-repair.ts: the moved function is byte for byte the old one, no failure carries answer content, at most one repair call; (g) pipeline/jev-harness.ts; (h) config.ts and the preload mirror of BrainId; (i) tests that would pass while the behaviour is broken. Do not edit files and do not run the whole suite.

Write findings to <FINDINGS FILE> with severity, file:line and the concrete scenario; write NO FINDINGS if none. Plain English.
```

Fix every finding, or decide on it in writing in the PR description.

- [ ] **Step 6: Open the pull request, wait for CI, merge, clean up**

Open the pull request against `main` with a description that lists the tasks, states "no visible change", and says what was measured (Claude Code JSON, Kiro effort, Gemini CLI flags measured or not). When CI is green and the review is closed, squash-merge with the branch deletion, fast-forward the main checkout, remove the worktree with `git worktree remove` (plain), and delete the scratch files by their literal names.
