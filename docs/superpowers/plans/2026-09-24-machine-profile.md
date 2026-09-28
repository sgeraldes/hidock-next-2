# Machine Profile, Execution Profiles and In-App Backup: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HiDock measures the machine it runs on, notices hardware and runtime changes without asking on every start, runs each heavy job on a runtime that passed a test on this machine (including the AMD GPU through DirectML), and keeps a small self-managed backup that restores on a new install.

**Architecture:** New modules under `apps/electron/electron/main/services/machine/`, `backup/` and `speakers-onnx/`, all TypeScript in the Electron main process or its utility processes, with no Python. State lives in the existing config (`config.ts`). Every heavy local job goes through a single-slot job gate that enforces the runtime, priority, CPU cap and the 50 ms GPU call budget.

**Tech Stack:** Electron 44, TypeScript, Vitest 4, `onnxruntime-node` 1.24.3 (CPU + DirectML execution providers), better-sqlite3 via `packages/database`, Node `crypto`/`zlib`/`worker_threads`.

**Spec:** `docs/superpowers/specs/2026-09-24-machine-profile-design.md` (requirements R1–R39, acceptance A1–A12)
**Design:** `docs/superpowers/specs/2026-09-24-machine-profile-architecture.md`

## Global Constraints

- No single GPU call over 50 ms on a GPU that drives a display (C1).
- One heavy local job at a time; below-normal priority; at most 50% of logical cores by default (C2).
- Nothing installed outside the app data folder; no administrator rights (C3).
- Every deletion by literal path; no glob, no recursive delete (C4).
- Downloads only from official sources, with SHA-256 pinned in `resources/models.lock.json` (C5).
- UI copy: plain English default, plain Spanish (rioplatense) for es-AR, no emoji; errors say what happened and the action (C6).
- Windows 10 1903+; `onnxruntime-node` 1.24.3 unless Task 9 proves DirectML needs another build (C7).
- Tests: Vitest, `/** @vitest-environment node */` header, files in `electron/main/services/**/__tests__/`, mocks of `../config` in the style of `speaker-setup.test.ts`.
- Heavy commands while developing (npm ci, builds, model exports, benchmarks) run one at a time, at below-normal priority, never in parallel with HiDock's own jobs.
- Commits end with no AI attribution lines.

## Review Focus

1. **Inventory read fails or times out at startup.** The expected behaviour is to keep the profile, show no "hardware changed" notice and flag the read error. Tested in Task 4 (`machine-state` treats a failed read as unchanged).
2. **The GPU that drives the display is the only GPU and a job's batch is too big.** The expected behaviour is to shrink the batch or fall back to CPU after two slow calls, and the desktop stays usable. Tested in Task 8 (`job-gate` degrade after two over-budget calls) and in Task 10's batch sizing.
3. **The app is killed mid-download, mid-measurement or mid-backup.** The expected behaviour on the next start is that leftover `.part`, probe and staging files are removed by name and nothing half-written is treated as valid. Tested in Task 7 (installer), Task 5 (probe cleanup) and Task 13 (backup staging).
4. **Restore of a backup made by a newer app version.** The expected behaviour is a refusal with "Update HiDock first", with the live database untouched. Tested in Task 14.
5. **A new table added to the schema later.** The expected behaviour is that it lands in the backup by default. Tested in Task 12 (unknown table is included).

---

## File Structure

| File | Responsibility |
|---|---|
| `electron/main/services/machine/types.ts` | Shared types: `Inventory`, `GpuInfo`, `RuntimeId`, `JobId`, `ProfileId`, `EnablerState`, `Measurement`, `QualificationResult` |
| `machine/inventory.ts` | Read hardware (PowerShell JSON), parse, filter virtual adapters |
| `machine/signature.ts` | Canonical object, SHA-256, field diff for notices |
| `machine/enablers.ts` | Per-runtime enabler checks from files/versions; enabler state hash |
| `machine/enabler-install.ts` | Download, checksum, rename, cleanup of `.part` |
| `machine/measure.ts` + `machine/measure-worker.ts` | CPU/GPU/storage timings in a utility process |
| `machine/profiles.ts` | Profile table, runtime resolution, availability, proposal |
| `machine/job-gate.ts` | Single-slot queue, runtime per job, thread cap, call budget |
| `machine/qualify.ts` | Qualification against bundled sample and references |
| `machine/machine-state.ts` | Stored state, startup check, change detection, notice, fallback |
| `electron/main/ipc/machine-handlers.ts` | IPC for Settings |
| `src/features/settings/ThisComputerSection.tsx` | Settings UI |
| `speakers-onnx/features.ts` | Kaldi-compatible 80-bin fbank on CPU |
| `speakers-onnx/clustering.ts` | Centroid agglomerative clustering |
| `speakers-onnx/onnx-diarizer.ts` | Segmentation + embedding sessions, windowing, batching |
| `backup/backup-plan.ts` | Exclude list, data version, retention selection |
| `backup/backup-writer.ts` | Snapshot, strip, compress, manifest, atomic rename |
| `backup/backup-restore.ts` | Verify, migrate staging, swap, queue re-embed |
| `backup/backup-scheduler.ts` | Idle trigger |
| `src/features/settings/BackupSection.tsx` | Backup UI |
| `resources/models.lock.json` | Downloadable items with URL, SHA-256, size, destination |
| `resources/qualification/*` | Sample audio + reference outputs |

Paths without a prefix are under `apps/electron/`.

---

## Phase 1: Know the machine (PR 1)

### Task 1: Shared types

**Files:**
- Create: `electron/main/services/machine/types.ts`
- Test: `electron/main/services/machine/__tests__/types.test.ts`

**Interfaces:**
- Produces: every type below, imported by all later tasks.

- [ ] **Step 1: Write the file**

```ts
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other'
export type RuntimeId = 'cpu' | 'directml' | 'cuda' | 'cloud' | 'remote'
export type JobId = 'transcription' | 'speakers' | 'voiceId' | 'embeddings' | 'analysis'
export type ProfileId = 'light' | 'balanced' | 'gpu' | 'remote' | 'custom'
export const JOBS: readonly JobId[] = ['transcription', 'speakers', 'voiceId', 'embeddings', 'analysis']

export interface GpuInfo {
  name: string
  vendor: GpuVendor
  driver: string | null
  vramBytes: number        // 0 when unknown
  drivesDisplay: boolean   // true when unknown (safe side of C1)
}

export interface Inventory {
  cpu: { model: string; physicalCores: number; logicalCores: number; maxClockMhz: number }
  ramBytes: number
  gpus: GpuInfo[]
  library: { drive: string; mediaType: 'SSD' | 'HDD' | 'Unknown'; busType: string; sizeBytes: number; striped: boolean }
  platform: NodeJS.Platform
  osRelease: string
}

export type InventoryRead = { ok: true; inventory: Inventory } | { ok: false; error: string }

export interface EnablerItem {
  id: string
  found: boolean
  version?: string
  installable: boolean
  sizeMb?: number
  fix?: string
}
export interface RuntimeEnablers { runtime: RuntimeId; present: boolean; items: EnablerItem[] }
export type EnablerState = Record<RuntimeId, RuntimeEnablers>

export interface Measurement {
  signature: string
  at: string
  cpu: { singleScore: number; multiScore: number }
  gpu: Array<{ gpuName: string; runtime: RuntimeId; loadMs: number; callMs: number }>
  storage: { writeMBps: number; readMBps: number } | null
}

export interface QualificationStep { job: JobId; runtime: RuntimeId; step: string; value: number; limit: number; passed: boolean }
export interface QualificationResult {
  profile: ProfileId
  signature: string
  enablerStateHash: string
  at: string
  passed: boolean
  steps: QualificationStep[]
}
```

- [ ] **Step 2: Write a compile guard test**

```ts
/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { JOBS } from '../types'
describe('machine types', () => {
  it('lists every job once', () => {
    expect(new Set(JOBS).size).toBe(5)
  })
})
```

- [ ] **Step 3: Run** `npx vitest run electron/main/services/machine/__tests__/types.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit** `git add electron/main/services/machine && git commit -m "machine: shared types"`

### Task 2: Inventory

**Files:**
- Create: `electron/main/services/machine/inventory.ts`
- Test: `electron/main/services/machine/__tests__/inventory.test.ts`
- Modify: `electron/main/services/hardware-profile.ts`: remove `vendorOf`, `NOT_A_GPU` and `parseWmiAdapters`, and re-export them from `./machine/inventory` so existing imports keep working

**Interfaces:**
- Consumes: `Inventory`, `InventoryRead`, `GpuInfo` (Task 1)
- Produces: `parseInventory(json: string | null, libraryDrive: string): InventoryRead`, `readInventory(libraryDrive: string, exec?: Exec): Promise<InventoryRead>`, `vendorOf(name, company?)`

- [ ] **Step 1: Write the failing tests** with the reference machine's real output as the fixture

```ts
/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { parseInventory } from '../inventory'

const OWNER = JSON.stringify({
  cpu: { Name: 'AMD Ryzen 9 7900X3D 12-Core Processor', NumberOfCores: 12, NumberOfLogicalProcessors: 24, MaxClockSpeed: 4401 },
  ramBytes: 68_000_000_000,
  gpus: [
    { Name: 'USB Mobile Monitor Virtual Display', AdapterCompatibility: 'Virtual', DriverVersion: '2.0.0.1', vram: 0, res: 1920 },
    { Name: 'AMD Radeon(TM) Graphics', AdapterCompatibility: 'Advanced Micro Devices, Inc.', DriverVersion: '32.0.21045.5002', vram: 536870912, res: null },
    { Name: 'AMD Radeon RX 6600 XT', AdapterCompatibility: 'Advanced Micro Devices, Inc.', DriverVersion: '32.0.21045.5002', vram: 8573157376, res: 3840 },
  ],
  disks: [{ MediaType: 'SSD', BusType: 'NVMe', Size: 2000398934016 }, { MediaType: 'SSD', BusType: 'NVMe', Size: 2000398934016 }],
  osRelease: '10.0.26200',
})

describe('inventory', () => {
  it('reads the owner machine and drops the virtual display', () => {
    const r = parseInventory(OWNER, 'F:')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.inventory.gpus.map((g) => g.name)).toEqual(['AMD Radeon(TM) Graphics', 'AMD Radeon RX 6600 XT'])
    expect(r.inventory.gpus[0].drivesDisplay).toBe(false)
    expect(r.inventory.gpus[1].drivesDisplay).toBe(true)
    expect(r.inventory.library.striped).toBe(true)
    expect(r.inventory.cpu.logicalCores).toBe(24)
  })
  it('treats unknown display state as driving a display', () => {
    const j = JSON.parse(OWNER); j.gpus[2].res = undefined
    const r = parseInventory(JSON.stringify(j), 'F:')
    expect(r.ok && r.inventory.gpus[1].drivesDisplay).toBe(true)
  })
  it('reports a failed read instead of an empty machine', () => {
    expect(parseInventory(null, 'F:')).toEqual({ ok: false, error: 'The hardware query did not run.' })
    expect(parseInventory('not json', 'F:').ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests.** Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement** `inventory.ts`. It has four parts:
  - `vendorOf` and `NOT_A_GPU`, moved verbatim from `hardware-profile.ts`.
  - The PowerShell script below, run as one `powershell.exe -NoProfile -NonInteractive -Command` with an 8000 ms timeout.
  - `parseInventory`, which maps: `vram` → `vramBytes` (0 if missing); `res` non-null → `drivesDisplay` true, explicitly `null` → false, `undefined` → true; `disks.length > 1` → `striped`; first disk's MediaType (`SSD`/`HDD`, else `Unknown`), BusType and summed Size.
  - A non-win32 branch that returns an inventory with an empty `gpus`, `mediaType: 'Unknown'` and CPU data from `os.cpus()`.

```powershell
$d = '<LIB>'.TrimEnd(':')
$p = Get-Partition -DriveLetter $d | Get-Disk
$phys = Get-PhysicalDisk | Where-Object { $p.Number -eq $_.DeviceId -or ($p.FriendlyName -match 'Storage Space') }
$gpus = Get-CimInstance Win32_VideoController | ForEach-Object {
  $key = Get-ChildItem 'HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath -Name DriverDesc -ErrorAction SilentlyContinue).DriverDesc -eq $_.Name } | Select-Object -First 1
  $vram = if ($key) { (Get-ItemProperty $key.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize' } else { $null }
  [pscustomobject]@{ Name=$_.Name; AdapterCompatibility=$_.AdapterCompatibility; DriverVersion=$_.DriverVersion; vram=$vram; res=$_.CurrentHorizontalResolution }
}
$c = Get-CimInstance Win32_Processor | Select-Object -First 1
[pscustomobject]@{
  cpu = @{ Name=$c.Name; NumberOfCores=$c.NumberOfCores; NumberOfLogicalProcessors=$c.NumberOfLogicalProcessors; MaxClockSpeed=$c.MaxClockSpeed }
  ramBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  gpus = @($gpus)
  disks = @($phys | Select-Object MediaType,BusType,Size)
  osRelease = [Environment]::OSVersion.Version.ToString()
} | ConvertTo-Json -Compress -Depth 4
```

The registry lookup matches `DriverDesc` to the adapter name inside the loop. Replace `$_` in the inner `Where-Object` with a captured `$gpu` variable (`$gpu = $_` at the top of the `ForEach-Object`) so the comparison uses the adapter, not the registry key.

- [ ] **Step 4: Run** `npx vitest run electron/main/services/machine/__tests__/inventory.test.ts electron/main/services/__tests__/hardware-profile.test.ts`. Expected: all PASS.
- [ ] **Step 5: Run it for real once** with `npx tsx -e "import('./electron/main/services/machine/inventory').then(m=>m.readInventory('F:')).then(r=>console.log(JSON.stringify(r,null,1)))"`. Expected: the RX 6600 XT with `vramBytes` around 8.5e9, the iGPU, and `striped: true`. Paste the output into the PR description.
- [ ] **Step 6: Commit** `git commit -am "machine: hardware inventory with VRAM, display flag and library drive"`

### Task 3: Signature and change description

**Files:**
- Create: `electron/main/services/machine/signature.ts`
- Test: `electron/main/services/machine/__tests__/signature.test.ts`

**Interfaces:**
- Consumes: `Inventory`
- Produces: `canonical(inv: Inventory): CanonicalMachine`, `signatureOf(inv: Inventory): string`, `describeChange(before: CanonicalMachine | null, after: CanonicalMachine): string[]`

- [ ] **Step 1: Failing tests**

```ts
/** @vitest-environment node */
import { describe, it, expect } from 'vitest'
import { canonical, signatureOf, describeChange } from '../signature'
import type { Inventory } from '../types'

const base: Inventory = {
  cpu: { model: 'AMD Ryzen 9 7900X3D', physicalCores: 12, logicalCores: 24, maxClockMhz: 4401 },
  ramBytes: 64 * 2 ** 30,
  gpus: [{ name: 'AMD Radeon RX 6600 XT', vendor: 'amd', driver: '32.0.1', vramBytes: 8 * 2 ** 30, drivesDisplay: true }],
  library: { drive: 'F:', mediaType: 'SSD', busType: 'NVMe', sizeBytes: 4e12, striped: true },
  platform: 'win32', osRelease: '10.0.26200',
}
const withx = (p: Partial<Inventory>): Inventory => ({ ...base, ...p })

describe('signature', () => {
  it('ignores driver updates', () => {
    expect(signatureOf(withx({ gpus: [{ ...base.gpus[0], driver: '99' }] }))).toBe(signatureOf(base))
  })
  it('ignores small RAM reporting noise and the display flag', () => {
    expect(signatureOf(withx({ ramBytes: 63.7 * 2 ** 30 }))).toBe(signatureOf(base))
  })
  it('changes when a GPU is added, RAM grows or the library moves', () => {
    const s = signatureOf(base)
    expect(signatureOf(withx({ gpus: [...base.gpus, { name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', driver: null, vramBytes: 24 * 2 ** 30, drivesDisplay: false }] }))).not.toBe(s)
    expect(signatureOf(withx({ ramBytes: 128 * 2 ** 30 }))).not.toBe(s)
    expect(signatureOf(withx({ library: { ...base.library, mediaType: 'HDD' } }))).not.toBe(s)
  })
  it('does not depend on GPU order', () => {
    const two = [...base.gpus, { name: 'AMD Radeon(TM) Graphics', vendor: 'amd' as const, driver: null, vramBytes: 2 ** 29, drivesDisplay: false }]
    expect(signatureOf(withx({ gpus: two }))).toBe(signatureOf(withx({ gpus: [...two].reverse() })))
  })
  it('describes changes in words', () => {
    const after = canonical(withx({ ramBytes: 128 * 2 ** 30 }))
    expect(describeChange(canonical(base), after)).toEqual(['RAM: 64 GB → 128 GB'])
    expect(describeChange(null, after)).toEqual(['First measurement of this computer'])
  })
})
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement**

```ts
import { createHash } from 'crypto'
import type { Inventory } from './types'

export interface CanonicalMachine { cpu: string; ramGb: number; gpus: string[]; library: string }

export function canonical(inv: Inventory): CanonicalMachine {
  return {
    cpu: `${inv.cpu.model}|${inv.cpu.logicalCores}`,
    ramGb: Math.round(inv.ramBytes / 2 ** 30 / 4) * 4,
    gpus: inv.gpus.map((g) => `${g.vendor}:${g.name}:${Math.round(g.vramBytes / 2 ** 30)}`).sort(),
    library: `${inv.library.mediaType}:${inv.library.busType}:${Math.round(inv.library.sizeBytes / 1e11)}`,
  }
}

export function signatureOf(inv: Inventory): string {
  return createHash('sha256').update(JSON.stringify(canonical(inv))).digest('hex')
}

const gpuLabel = (s: string) => { const [, name, gb] = s.split(':'); return `${name} (${gb} GB)` }

export function describeChange(before: CanonicalMachine | null, after: CanonicalMachine): string[] {
  if (!before) return ['First measurement of this computer']
  const out: string[] = []
  if (before.cpu !== after.cpu) out.push(`CPU: ${before.cpu.split('|')[0]} → ${after.cpu.split('|')[0]}`)
  if (before.ramGb !== after.ramGb) out.push(`RAM: ${before.ramGb} GB → ${after.ramGb} GB`)
  for (const g of after.gpus) if (!before.gpus.includes(g)) out.push(`GPU added: ${gpuLabel(g)}`)
  for (const g of before.gpus) if (!after.gpus.includes(g)) out.push(`GPU removed: ${gpuLabel(g)}`)
  if (before.library !== after.library) out.push(`Library drive changed: ${before.library.split(':')[0]} → ${after.library.split(':')[0]}`)
  return out
}
```

- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "machine: hardware signature and change description"`

### Task 4: Enabler state and machine state (startup check)

**Files:**
- Create: `electron/main/services/machine/enablers.ts`, `electron/main/services/machine/machine-state.ts`
- Modify: `electron/main/services/config.ts`: add the `machine` section with the defaults below, in the `AppConfig` type, the defaults object and the migration of the config file
- Test: `machine/__tests__/enablers.test.ts`, `machine/__tests__/machine-state.test.ts`

**Interfaces:**
- Consumes: `Inventory`, `signatureOf`, `canonical`, `describeChange`, `EnablerState`
- Produces:
  - `readEnablerState(inv: Inventory, fs?: EnablerFs): EnablerState`
  - `enablerStateHash(s: EnablerState): string`
  - `startupCheck(deps: StartupDeps): Promise<StartupOutcome>`, where `StartupOutcome = { kind: 'unchanged' } | { kind: 'read-failed'; error: string } | { kind: 'changed'; changes: string[]; signature: string; enablerStateHash: string }`

Config defaults:

```ts
machine: {
  signature: null, canonical: null, inventory: null, enablerState: null, enablerStateHash: null,
  measurement: null, profile: 'light', custom: {}, qualification: null, dismissedChange: null, readError: null,
}
```

- [ ] **Step 1: Failing tests for enablers.** Inject a fake `EnablerFs = { exists(p): boolean; sha256(p): string | null; nvidiaDriver(): string | null }`. Cases:
  - DirectML is present when `DirectML.dll` exists next to the `onnxruntime-node` binary, `osRelease` ≥ `10.0.18362`, and the model files match `models.lock.json`.
  - DirectML is absent, with `fix` naming the missing item, when the DLL is missing.
  - CUDA is absent, with `installable: false` and the fix "Install the NVIDIA driver 550 or newer from nvidia.com", when `nvidiaDriver()` returns null.
  - The hash is identical for the same state and different when one item's `found` flips.
- [ ] **Step 2: Failing tests for `startupCheck`**:
  1. The stored signature and hash equal the current ones: returns `unchanged`, and the fake `measure` and `notify` are not called (A1).
  2. The inventory read fails: returns `read-failed`, the config's `profile` is unchanged, and `readError` is set (A4, Review Focus 1).
  3. The stored RAM is 32 GB and the current one is 64 GB: returns `changed` with `['RAM: 32 GB → 64 GB']` (A2).
  4. Only the enabler hash differs: returns `changed` with `['Runtime software changed: directml']`.
  5. A driver-only difference returns `unchanged` (A3).
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement `enablers.ts`:**
  - Locate the `onnxruntime-node` binary folder with `require.resolve('onnxruntime-node/package.json')` + `/bin/napi-v6/win32/x64/`.
  - Read `resources/models.lock.json` for model file checks.
  - The CUDA minimum driver is the constant `CUDA_MIN_DRIVER = '550.0'`.
  - Cloud and remote read `lastCloudCheckAt` and `modelHostLastHealthAt` from config.
  - The hash is SHA-256 of `Object.values(state).flatMap(r => r.items.map(i => \`${r.runtime}:${i.id}@${i.version ?? ''}|${i.found}\`)).sort().join('\n')`.
- [ ] **Step 5: Implement `machine-state.ts`:**
  - `startupCheck({ readInventory, readEnablers, config })` compares, and on `changed` returns without side effects.
  - `recordChecked(outcome)` writes `signature`, `canonical`, `inventory`, `enablerState`, `enablerStateHash`, and clears `readError`.
  - The heavy follow-up (measure, requalify, notify) is Task 11's orchestration, so this task stays pure and testable.
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Wire it at startup.** In `electron/main/index.ts`, after the main window's `ready-to-show`, call `setImmediate(() => runMachineStartup())`, where `runMachineStartup` calls `startupCheck` and logs `[Machine] unchanged` / `[Machine] changed: …` / `[Machine] read failed: …`. On `changed` it stores the new state and nothing else yet.
- [ ] **Step 8: Verify for real.** Run `npm run dev` twice. The first run logs `changed: First measurement of this computer`, and the second logs `unchanged`. Paste both log lines into the PR.
- [ ] **Step 9: Commit** `git commit -am "machine: enabler state and silent startup check"`

### Task 5: Measurement in a utility process

**Files:**
- Create: `machine/measure.ts` (parent), `machine/measure-worker.ts` (utility process), `resources/qualification/probe-conv.onnx`
- Create: `scripts/make-probe-model.mjs`, which builds the probe with `onnx` graph primitives through `onnxruntime-node`-compatible opset 17: three Conv 3×3 layers of 32 channels on a 1×32×64×64 input
- Test: `machine/__tests__/measure.test.ts`

**Interfaces:**
- Consumes: `Inventory`, `EnablerState`
- Produces: `measure(inv, enablers, opts: { libraryDir: string; signal: AbortSignal }): Promise<Measurement>`, `cleanupProbeFile(libraryDir: string): void`

- [ ] **Step 1: Failing tests** with injected timers and fs:
  - The storage probe writes `<libraryDir>/.hidock-disk-probe.tmp` and deletes exactly that path.
  - `cleanupProbeFile` deletes that exact path if it exists and touches nothing else (Review Focus 3).
  - GPU timing is skipped for runtimes whose enablers are absent.
  - Aborting through the signal stops before the next step.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The parent forks the worker with `utilityProcess.fork` and `serviceName: 'hidock-measure'`, then calls `os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)`.
  - The worker computes the CPU score as iterations of `x = Math.sqrt(x * 1.0000001 + 1)` in 1000 ms. Multi-core runs the same loop in `floor(logical/2)` `worker_threads`.
  - GPU timing creates a session with `executionProviders: ['dml']` and `{ deviceId }` for each GPU index, or `['cuda']`. It records the load time, then the median of 20 runs of a zero tensor.
  - Storage writes 64 blocks of 4 MB with `fs.writeSync` and `fs.fsyncSync`, reads them back, then `fs.unlinkSync(literalPath)`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Measure the reference machine once** and record the numbers (CPU scores, RX 6600 XT and iGPU DirectML `callMs`, F: MB/s) in the PR description. They set the Balanced threshold in Task 6.
- [ ] **Step 6: Commit** `git commit -am "machine: measurement in a low-priority utility process"`

## Phase 2: Profiles, gate, installs and qualification (PR 2)

### Task 6: Profiles, availability and proposal

**Files:**
- Create: `machine/profiles.ts`
- Test: `machine/__tests__/profiles.test.ts`

**Interfaces:**
- Consumes: `Inventory`, `EnablerState`, `Measurement`
- Produces:
  - `resolveRuntimes(profile: ProfileId, ctx: ProfileContext): Record<JobId, RuntimeId> | null`, where null means unavailable
  - `availability(ctx): Record<ProfileId, { available: boolean; reason?: string; fix?: string }>`
  - `propose(ctx): ProfileId`
  - `pickGpu(inv, enablers, measurement): { gpu: GpuInfo; runtime: 'cuda' | 'directml' } | null`
  - `BALANCED_MIN_MULTI_SCORE`

`ProfileContext = { inventory: Inventory; enablers: EnablerState; measurement: Measurement | null; custom: Partial<Record<JobId, RuntimeId>> }`

- [ ] **Step 1: Failing tests:**
  - Owner machine, DirectML present: `propose` → `gpu`, and `pickGpu` picks the **iGPU when it passes the 50 ms budget, since it does not drive the display**, else the RX 6600 XT.
  - 8 GB RAM laptop with no GPU runtime → `light`. `balanced` is unavailable with the reason "Needs 16 GB of RAM; this computer has 8 GB".
  - 32 GB RAM, no GPU, fast CPU → `balanced`.
  - A paired and healthy remote host → `remote`.
  - DirectML absent: `gpu` is unavailable with the fix "Install GPU runtime (DirectML, 18 MB)" (A5).
  - `custom` with `speakers: 'cuda'` on a machine without CUDA → null.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the table from the design §8.
  - `pickGpu` prefers CUDA, then a non-display GPU on DirectML whose measured `callMs` ≤ 50, then the display GPU on DirectML with `callMs` ≤ 50.
  - Set `BALANCED_MIN_MULTI_SCORE` to 60% of the reference multi score from Task 5.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "machine: profiles, availability and proposal"`

### Task 7: Enabler installer

**Files:**
- Create: `machine/enabler-install.ts`, `resources/models.lock.json`
- Test: `machine/__tests__/enabler-install.test.ts`

**Interfaces:**
- Produces: `installItem(item: LockItem, deps: InstallDeps, onProgress?: (pct: number) => void): Promise<void>`, `cleanupPartials(root: string, now: number): string[]`

`LockItem = { id: string; url: string; sha256: string; sizeMb: number; dest: string }`, where `dest` is relative to `<userData>`.

- [ ] **Step 1: Failing tests** with a fake fetch stream and an in-memory fs:
  - A checksum match renames `.part` to the final name.
  - A mismatch deletes `<dest>.part` by its literal path and throws `Checksum mismatch for <id>: the download was discarded. Try again.`
  - `cleanupPartials` removes only `.part` files listed in the lock file's destinations that are older than 1 h, and returns their literal paths (Review Focus 3).
  - A URL whose host is not in `ALLOWED_HOSTS = ['huggingface.co', 'github.com', 'objects.githubusercontent.com', 'developer.download.nvidia.com']` is refused (C5).
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** with `fetch` + `crypto.createHash('sha256')` while streaming to `fs.createWriteStream`, then `fs.renameSync`.
- [ ] **Step 4: Fill `models.lock.json`** with the real items once Task 9 and Task 10 decide the model files: `segmentation-3.0.onnx`, `wespeaker-resnet34-lm-fbank.onnx`, and the embedding model. Each entry needs its URL and the SHA-256 computed from the downloaded file.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `git commit -am "machine: enabler installer with pinned checksums"`

### Task 8: Job gate

**Files:**
- Create: `machine/job-gate.ts`
- Modify:
  - `local-embedder-runtime.ts`: `createSession` takes a `RuntimeId`, where `directml` maps to `['dml','cpu']` and `cpu` to `['cpu']`; wrap `embed` calls in `runHeavyJob('embeddings', …)`
  - `speaker-linking.ts`: wrap the worker launch in `runHeavyJob('speakers', …)`
  - `transcription.ts`: wrap diarization in `runHeavyJob('speakers', …)`
- Test: `machine/__tests__/job-gate.test.ts`

**Interfaces:**
- Consumes: `resolveRuntimes`, `pickGpu`
- Produces:
  - `runHeavyJob<T>(job: JobId, fn: (ctx: JobContext) => Promise<T>): Promise<T>`
  - `JobContext = { runtime: RuntimeId; gpuDeviceId: number | null; threads: number; callBudgetMs: number | null; recordCall(ms: number): void; readonly degradedToCpu: boolean; signal: AbortSignal }`
  - `isHeavyJobRunning(): boolean`

- [ ] **Step 1: Failing tests:**
  - Two jobs started together run one after the other: the second's start is after the first's end (R22).
  - `threads` equals `max(1, floor(24 * 50 / 100)) = 12` for 24 logical cores and `cpuPercent` 50.
  - `callBudgetMs` is 50 on a display GPU, and null on the CPU and on a non-display GPU.
  - After two `recordCall(60)` calls, `degradedToCpu` is true. One slow call is not enough (R24, Review Focus 2).
  - A job whose profile runtime is `cloud` throws `Job <job> is assigned to the cloud; no local model may load` if it asks for a local session (R25).
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** with a promise chain as the single slot. The budget counter lives in the context. The degradation event is written to the caller's `quality_json` through a returned `ctx.events` array.
- [ ] **Step 4: Run the gate tests, then the whole suite** with `npx vitest run`. Expected: all PASS. Existing embedder tests pass `runtime: 'cpu'`.
- [ ] **Step 5: Commit** `git commit -am "machine: single-slot job gate with GPU call budget"`

### Task 9: DirectML availability proof

**Files:**
- Create: `scripts/dml-smoke.mjs`

- [ ] **Step 1: Write the script.** It loads `probe-conv.onnx` with `executionProviders: [{ name: 'dml', deviceId: N }]` for N = 0, 1, prints the provider actually used, and prints the median call time of 20 runs.
- [ ] **Step 2: Run it** at below-normal priority: `start /low /affinity FFF node scripts/dml-smoke.mjs`. Expected: both AMD adapters answer. Record the times.
- [ ] **Step 3: If `dml` is not in the 1.24.3 Windows build,** switch the dependency to the `onnxruntime-node` release that ships it. Run the whole suite, record the version in the PR, and update C7 in the SPEC in the same commit.
- [ ] **Step 4: Commit** `git commit -am "machine: prove DirectML on the reference GPUs"`

### Task 10: Qualification

**Files:**
- Create: `machine/qualify.ts`, `resources/qualification/sample-2spk-30s.wav`, `sample.rttm`, `sample-embeddings.f32`, `sample-text-embedding.f32`, and `scripts/make-qualification-refs.mjs` to produce the reference files on CPU
- Test: `machine/__tests__/qualify.test.ts`

**Interfaces:**
- Consumes: `runHeavyJob`, `resolveRuntimes`, the diarizer (`diarize(audio, ctx)` from Task 16; until then, qualification covers embeddings only and marks speakers `skipped`), `embedTexts(texts, ctx)` from `local-embedder-runtime.ts`
- Produces: `qualify(profile: ProfileId, ctx: ProfileContext): Promise<QualificationResult>`

- [ ] **Step 1: Failing tests** with fake jobs:
  - All steps within limits: `passed: true`.
  - A call over 50 ms on a display GPU: `passed: false`, with a step `{ step: 'call time', value: 61, limit: 50 }` (A6).
  - Embedding cosine 0.97: fails with step `'embedding similarity'`.
  - Speaker overlap 0.93: fails with step `'speaker overlap'`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Overlap is the share of reference speaker time assigned to the matching hypothesis speaker, using the best assignment over permutations (two speakers).
  - Cosine is computed per window, and the minimum is taken.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "machine: qualification against bundled sample"`

### Task 11: Orchestration, IPC and Settings UI

**Files:**
- Create: `machine/machine-flow.ts`, `electron/main/ipc/machine-handlers.ts`, `src/features/settings/ThisComputerSection.tsx`, `src/features/settings/MachineChangeBanner.tsx`
- Modify: `electron/main/index.ts` (replace the Task 4 stub with `runMachineFlow`), `electron/preload/index.ts` (expose `machine.*`), the settings page that lists sections, and the i18n files for `en` and `es-AR`
- Test: `machine/__tests__/machine-flow.test.ts`, `src/features/settings/__tests__/ThisComputerSection.test.tsx`

**Interfaces:**
- IPC:
  - `machine:get` → `{ inventory, measurement, profile, availability, qualification, perJobLastRun, change: { changes: string[] } | null, readError }`
  - `machine:measure` → the same shape
  - `machine:select` `(profile, custom?)` → a `QualificationResult`
  - `machine:install` `(itemId)` → progress events on `machine:install-progress`
  - `machine:dismiss` → void

- [ ] **Step 1: Failing flow tests:**
  - On `changed`, the flow waits while `isHeavyJobRunning()` is true (R7), measures, requalifies the active profile, and keeps it on pass.
  - On fail, it falls back to the best available profile that qualifies, else `light`, and records why.
  - It sets the banner unless `dismissedChange === \`${sig}|${hash}\`` (R14).
  - `select` does not change `config.machine.profile` when qualification fails (R20).
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement the flow and the handlers.**
- [ ] **Step 4: UI component test** with Testing Library:
  - Unavailable profiles render disabled, with the reason and the fix button.
  - A failed qualification shows the failed step's text `Call time 61 ms, limit 50 ms`.
  - The banner shows each change line and the buttons "Use <proposed>" and "Decide later".
- [ ] **Step 5: Implement the UI** following the existing settings sections' components and tokens (see `src/features/settings/`). The copy is in both locales. Use no emoji.
- [ ] **Step 6: Run** `npx vitest run`, `npm run typecheck` and `npx eslint` on the touched files. Expected: clean.
- [ ] **Step 7: Verify in the running app** with `npm run dev`:
  - Open Settings → This computer and take a screenshot.
  - Change `config.machine.canonical.ramGb` to 32 in the config file, restart, and see the banner "RAM: 32 GB → 64 GB". Take a screenshot.
  - Attach both screenshots to the PR.
- [ ] **Step 8: Commit** `git commit -am "machine: change flow, IPC and Settings section"`

## Phase 3: The AMD speaker path (PR 3)

Phase 3 is Tasks 15–17 and Phase 4 is Tasks 12–14 and 18. The numbers are not in phase order because the two phases are independent and can go in parallel PRs. Phase 3 needs Tasks 8 and 9 done first.

### Task 15: Fbank features on CPU

**Files:**
- Create: `speakers-onnx/features.ts`
- Test: `speakers-onnx/__tests__/features.test.ts`, fixture `__tests__/fixtures/fbank-ref.json` produced by `torchaudio.compliance.kaldi.fbank(num_mel_bins=80, frame_length=25, frame_shift=10, dither=0)` on a 2-second sine + noise clip. The fixture is generated once with the existing dev venv, and the script is committed as `scripts/make-fbank-fixture.py`.

**Interfaces:**
- Produces: `fbank(samples: Float32Array, sampleRate: 16000): { data: Float32Array; frames: number; bins: 80 }`

- [ ] **Step 1: Failing test.** The maximum absolute difference to the fixture is ≤ 1e-3 on every value.
- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement** the Kaldi recipe:
  1. Frames of 400 samples with a hop of 160.
  2. Remove the DC offset per frame, pre-emphasis 0.97, Povey window.
  3. FFT size 512, power spectrum.
  4. 80 mel bins from 20 Hz to 8000 Hz, Kaldi mel scale.
  5. Log with floor `Number.EPSILON`.
  6. Subtract the mean per bin over the utterance, as WeSpeaker does.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "speakers-onnx: Kaldi fbank on CPU"`

### Task 16: ONNX diarizer on DirectML

**Files:**
- Create: `speakers-onnx/onnx-diarizer.ts`, `speakers-onnx/clustering.ts`, `scripts/export-wespeaker-fbank.py`, which re-exports the embedder so the graph input is `[batch, frames, 80]` fbank with dynamic batch, run once in the dev venv
- Modify: `speaker-engines.ts`: the `onnx-local` engine points at the new diarizer
- Test: `speakers-onnx/__tests__/clustering.test.ts`, `speakers-onnx/__tests__/onnx-diarizer.test.ts` (fake sessions)

**Interfaces:**
- Consumes: `fbank`, `runHeavyJob` context (`runtime`, `gpuDeviceId`, `callBudgetMs`, `recordCall`, `degradedToCpu`)
- Produces: `diarize(audio: Float32Array, ctx: JobContext): Promise<{ segments: Array<{ start: number; end: number; speaker: string }>; voices: Array<{ speaker: string; embedding: Float32Array }> }>`, the shape `speaker-linking.ts` consumes today

- [ ] **Step 1: Failing clustering test.** Three well-separated embedding groups give 3 clusters at threshold 0.7045654963945799 with centroid linkage. Two near-identical groups give 1.
- [ ] **Step 2: Failing diarizer tests** with fake sessions that each take a fixed time:
  - The batch size shrinks until the fake call time is ≤ `callBudgetMs`.
  - After `degradedToCpu`, new sessions are created with `['cpu']`.
  - Output segments are sorted and non-overlapping per speaker.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement:**
  - Segmentation uses 10 s windows with a 1 s step.
  - Batch sizing starts at 1 and doubles while `callMs * 1.2 ≤ budget`.
  - Embeddings are computed per active local speaker with masking.
  - Global clustering, then reconstruction of turns.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Export the embedder graph** at low priority, add both graphs to `models.lock.json` with their SHA-256, and commit.

### Task 17: Reference comparison on the RX 6600 XT (A7, A8)

**Files:**
- Create: `scripts/compare-diarizers.mjs` (dev-only, not in CI)

- [ ] **Step 1: Pick 5 recordings from the library**, among them one under 2 minutes, one over 90 minutes, and three between. Note their ids in the PR.
- [ ] **Step 2: Produce the CPU pyannote reference** for each. This is heavy, so run one at a time, at low priority, with nothing else running. Store the outputs under `F:\HiDock-Next-Data\artifacts\diarizer-ref\`, outside the repo.
- [ ] **Step 3: Run the ONNX diarizer on DirectML** for each, through `runHeavyJob`. Record the maximum call ms, the speaker count, the overlap and the time per audio minute.
- [ ] **Step 4: Measure desktop responsiveness** during the 90-minute run. A helper window posts an input event every 100 ms and records the handling delay. Pass: p95 < 100 ms (A8).
- [ ] **Step 5: Fix and re-run** anything outside R19 or C1 until it passes. Paste the results table into the PR.
- [ ] **Step 6: Commit** `git commit -am "speakers-onnx: verified on RX 6600 XT against CPU pyannote"`

## Phase 4: Backup in the app (PR 4)

### Task 12: Backup plan (exclusions, data version, retention)

**Files:**
- Create: `backup/backup-plan.ts`
- Test: `backup/__tests__/backup-plan.test.ts`

**Interfaces:**
- Produces:
  - `EXCLUDED_TABLES: ReadonlySet<string>`
  - `tablesToBackUp(allTables: string[]): string[]`
  - `dataVersion(db: DbLike, tables: string[]): string`
  - `selectForDeletion(files: Array<{ path: string; at: Date; size: number }>, now: Date, capBytes: number): string[]`

- [ ] **Step 1: Build the exclude list from the schema.** Run `SELECT name FROM sqlite_master WHERE type='table'` on the reference database, then classify each table as rebuildable or not. Rebuildable means it is recomputed by a pipeline stage listed in `processing_runs.stage` or it is an index or cache. Write the list into the file with a one-line reason per table. `vector_embeddings` is the first entry.
- [ ] **Step 2: Failing tests:**
  - A table not in the list is included (Review Focus 5).
  - `vector_embeddings` is excluded.
  - Retention keeps the newest file, the previous one, and the newest file older than 7 days, and deletes the rest.
  - When the total size is over the cap, it deletes the oldest kept file other than the newest.
  - It returns literal paths only.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `git commit -am "backup: what goes in, change detection, retention"`

### Task 13: Backup writer and scheduler

**Files:**
- Create: `backup/backup-writer.ts`, `backup/backup-scheduler.ts`
- Modify: `config.ts`: add the `backup` section `{ folder: null, capMb: 1024, lastAt: null, lastFile: null, lastSize: null, lastDataVersion: null }`
- Test: `backup/__tests__/backup-writer.test.ts` (a real temporary better-sqlite3 database with three tables, one excluded), `backup/__tests__/backup-scheduler.test.ts` (fake clock)

**Interfaces:**
- Produces:
  - `writeBackup(opts: { db: BetterSqlite3Database; folder: string; appVersion: string; schemaVersion: number }): Promise<{ file: string; size: number; manifest: BackupManifest }>`
  - `BackupManifest = { format: 1; appVersion: string; schemaVersion: number; createdAt: string; tables: Record<string, number>; sha256: string }`
  - `startBackupScheduler(deps)`

- [ ] **Step 1: Failing writer tests:**
  - The output contains the included tables with the same row counts and no excluded table.
  - The manifest checksum matches the compressed payload.
  - A crash simulated after the staging step leaves `.staging.db`, which the next `writeBackup` removes by literal path before starting (Review Focus 3).
  - The `.part` rename is atomic.
- [ ] **Step 2: Failing scheduler tests:**
  - With no data change for 24 h, nothing is written (A10).
  - A change followed by 10 idle minutes writes once.
  - A running heavy job postpones the backup.
  - A second change within 24 h waits until the day has passed.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement:**
  1. `VACUUM INTO` staging.
  2. Open staging, `DROP TABLE` for the excluded tables, `VACUUM`.
  3. Compress with `zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })`.
  4. File layout: 4-byte header length, JSON manifest, payload.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Measure on a copy of the reference database,** never the live file. Expected: output ≤ 200 MB (A10). Record the size and duration in the PR.
- [ ] **Step 7: Commit** `git commit -am "backup: compressed snapshot of irreplaceable data, idle scheduler"`

### Task 14: Restore, pre-migration copy and UI

**Files:**
- Create: `backup/backup-restore.ts`, `src/features/settings/BackupSection.tsx`
- Modify:
  - `packages/database/src/engine.ts`: replace `backupOnBoot`, `deferredBackupPending` and `externalBackups` with `preMigrationCopy()`, which runs `VACUUM INTO <db>.pre-migration.db` only when migrations are pending, and a `clearPreMigrationCopy()` called after the first successful start
  - `electron/main/services/boot-tasks.ts`: remove the `database-backup` task
  - The onboarding step list: add the restore offer when the library is empty
- Test: `backup/__tests__/backup-restore.test.ts`, `packages/database/src/__tests__/pre-migration.test.ts`, `src/features/settings/__tests__/BackupSection.test.tsx`

**Interfaces:**
- Produces:
  - `readManifest(file): BackupManifest`
  - `restoreBackup(file, deps): Promise<void>`, which throws `RestoreError` with the user-facing messages below
  - IPC `backup:get`, `backup:now`, `backup:choose-folder`, `backup:restore`

- [ ] **Step 1: Failing restore tests:**
  - A round trip of write then restore into an empty database gives equal row counts per included table, and a re-embed job is queued (A11).
  - A manifest with `schemaVersion` above the app's is refused with "This backup comes from a newer HiDock. Update HiDock first." The live database is untouched (Review Focus 4).
  - A bad checksum is refused with "The backup file is damaged. Choose another backup."
- [ ] **Step 2: Failing engine tests:**
  - No pending migration: no copy is made.
  - Pending migration: one copy exists before the first migration runs, and it is removed after `clearPreMigrationCopy()`.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement:**
  1. Decompress to staging.
  2. Run migrations on staging.
  3. Close the live database, rename live → `<db>.before-restore`, rename staging → live.
  4. Relaunch.
  5. After the first successful start, delete `<db>.before-restore` by literal path.
- [ ] **Step 5: Implement `BackupSection.tsx`:** last backup date, size and folder; folder picker; cap; "Back up now"; "Restore…" with a confirmation that names the file date and row counts.
- [ ] **Step 6: Run** `npx vitest run`, the typecheck and eslint. Expected: clean.
- [ ] **Step 7: Verify for real:**
  1. In the dev app, click "Back up now".
  2. Point `userData` at an empty temporary folder, start the app, and restore from the file.
  3. Compare row counts against the manifest.
  4. Take screenshots of both screens for the PR.
- [ ] **Step 8: Commit** `git commit -am "backup: restore, pre-migration copy, Settings section"`

### Task 18: Remove the old backup (A12)

Only after Task 14 step 7 passes on the reference machine.

- [ ] **Step 1: Unregister the task** with `Unregister-ScheduledTask -TaskName HiDock-DB-Backup -Confirm:$false`, then confirm `Get-ScheduledTask HiDock-DB-Backup` returns nothing.
- [ ] **Step 2: Remove the script and its tests** with `git rm apps/electron/scripts/backup-db.py`, plus any test file that imports it (find them with `git grep -l backup-db`).
- [ ] **Step 3: List `F:\HiDock-Next-Data\backups` and `F:\HiDock-Next-Data\data`,** save the listing in the PR, then delete each old copy with one `Remove-Item -LiteralPath '<full path>'` per file. That covers the `hidock-*.db` files, their `.source.json` files, `hidock.before-*.db` and its `-shm`/`-wal` files, and `hidock.db.bak-*`. Never delete `hidock.db` or its `-wal`/`-shm` files.
- [ ] **Step 4: Record F: free space** before and after in the PR.
- [ ] **Step 5: Commit** `git commit -am "backup: retire the hourly script and scheduled task"`

## Definition of Done per PR

Each of the four PRs goes through:
- all tests, the typecheck and lint;
- the real verification steps listed in its tasks, with evidence in the PR;
- the adversarial review with `claude2openai` (gpt-5.6-sol, high effort);
- merge;
- worktree and branch cleanup.

## Self-review record

- Spec coverage:

  | Requirements | Task |
  |---|---|
  | R1–R5 | Tasks 2, 4 |
  | R6–R9 | Task 5 |
  | R10–R12 | Tasks 4, 7 |
  | R13–R14 | Tasks 4, 11 |
  | R15–R18 | Tasks 6, 11 |
  | R19–R21 | Tasks 10, 11 |
  | R22–R25 | Task 8 |
  | R26–R29 | Tasks 9, 15, 16, 17 |
  | R30–R38 | Tasks 12, 13, 14 |
  | R39 | Task 18 |

  R29 (embeddings on DirectML) is covered by Task 8's runtime mapping and Task 10's embedding qualification.
- Types: `JobContext`, `ProfileContext`, `RuntimeId` and `QualificationResult` are defined in Tasks 1, 6 and 8 and used with the same names afterwards.
- Placeholders: the model URLs and SHA-256 values in Task 7 step 4 are filled from files that Tasks 9 and 16 produce. They are measured values, not unknowns, and the step names the command that produces them.
