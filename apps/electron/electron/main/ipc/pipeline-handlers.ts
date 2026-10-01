/**
 * IPC for the Settings > Pipeline page. Namespace: `pipeline:*`.
 *
 * `getState` is everything the page draws: the owner's configuration, the harnesses that can write text with
 * their availability and the reason when they have none, and the median time and cost of each step from the
 * ledger. `saveStep` applies a draft with the shared `applyStepDraft`, validates the result with the shared
 * `validatePipelineConfig` (the page ran the same function live), asks once for confirmation when a slow
 * harness is chosen for a step that runs in bulk, and saves by replacing the section: `updateConfig` merges
 * deeply and could never remove a profile. Saves are serialised so two that arrive together cannot lose each
 * other's profile. `listModels` goes through the discovery cache of phase 1: it never throws and never waits
 * more than a few seconds.
 */
import { ipcMain } from 'electron'
import { getConfig, replaceConfigSection } from '../services/config'
import { discoverModels, getBrainRegistry, getBrainRouter, type BrainId } from '../services/brains'
import { isBrainCoolingDown } from '../services/brains/brain-cooldown'
import { getStepStats } from '../services/pipeline/call-store'
import { listHarnessInfos } from '../services/pipeline/harness-info'
import {
  TEXT_STEP_IDS,
  applyStepDraft,
  emptyPipelineConfig,
  validatePipelineConfig,
  type HarnessInfo,
  type HarnessState,
  type ModelOption,
  type PipelineSettingsState,
  type SaveStepArgs,
  type SaveStepResult,
  type StepChoice,
  type StepStats
} from '../../../src/shared/pipeline-config'

/** The window of the numbers beside each step. */
const STATS_WINDOW_DAYS = 30

async function unavailableReason(id: string): Promise<string> {
  if (isBrainCoolingDown(id as BrainId)) return 'Out of quota for now; it rests until the limit resets.'
  try {
    const status = await getBrainRegistry().get(id as BrainId)?.authStatus()
    if (status && !status.configured) return status.detail ?? 'Not set up.'
  } catch {
    return 'Its status could not be read.'
  }
  return 'Turned off in Settings > AI providers.'
}

async function harnessState(info: HarnessInfo): Promise<HarnessState> {
  const available = await getBrainRouter()
    .canServe(info.id as BrainId, 'chat')
    .catch(() => false)
  return { ...info, available, reason: available ? null : await unavailableReason(info.id) }
}

function readStats(): Record<string, StepStats> {
  try {
    return getStepStats(new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000).toISOString())
  } catch {
    // No ledger yet (or it cannot be read): the page shows "No calls yet" instead of failing.
    return {}
  }
}

export async function buildState(): Promise<PipelineSettingsState> {
  const harnesses = await Promise.all(
    listHarnessInfos()
      .filter((h) => h.textCapable)
      .map(harnessState)
  )
  return { config: getConfig().pipeline ?? emptyPipelineConfig(), harnesses, stats: readStats() }
}

const isChoice = (value: unknown): value is StepChoice =>
  value === 'auto' ||
  (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { harness?: unknown }).harness === 'string')

function parseSaveArgs(args: unknown): SaveStepArgs | null {
  if (typeof args !== 'object' || args === null) return null
  const a = args as Record<string, unknown>
  if (!(TEXT_STEP_IDS as readonly string[]).includes(a.step as string)) return null
  if (!isChoice(a.primary)) return null
  if (a.fallback !== null && !isChoice(a.fallback)) return null
  return { step: a.step as SaveStepArgs['step'], primary: a.primary, fallback: a.fallback as StepChoice | null, confirmSlow: a.confirmSlow === true }
}

let queue: Promise<unknown> = Promise.resolve()

async function saveOne(args: SaveStepArgs): Promise<SaveStepResult> {
  const current = getConfig().pipeline ?? emptyPipelineConfig()
  const candidate = applyStepDraft(current, args.step, args.primary, args.fallback)
  const issues = validatePipelineConfig(candidate, listHarnessInfos())
  if (issues.some((i) => i.severity === 'error')) return { success: false, issues }
  if (!args.confirmSlow && issues.some((i) => i.code === 'slow-bulk' && i.step === args.step)) {
    return { success: false, needsConfirmation: true, issues }
  }
  await replaceConfigSection('pipeline', candidate)
  return { success: true, issues }
}

export async function saveStep(raw: unknown): Promise<SaveStepResult> {
  const args = parseSaveArgs(raw)
  if (!args) return { success: false, error: 'The request is not a valid step choice.' }
  const run = queue.then(() => saveOne(args))
  queue = run.catch(() => undefined)
  try {
    return await run
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function listModels(harness: string): Promise<ModelOption[]> {
  const info = listHarnessInfos().find((h) => h.id === harness)
  const brain = info?.textCapable ? getBrainRegistry().get(harness as BrainId) : null
  return brain ? discoverModels(brain) : []
}

export function registerPipelineHandlers(): void {
  ipcMain.handle('pipeline:getState', () => buildState())
  ipcMain.handle('pipeline:saveStep', (_e, args: unknown) => saveStep(args))
  ipcMain.handle('pipeline:listModels', (_e, args: { harness?: unknown } | null) =>
    listModels(typeof args?.harness === 'string' ? args.harness : '')
  )
}
