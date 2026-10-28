/**
 * Boot-task feature gating (Gate 1) — a disabled feature's tasks are NEVER
 * registered on the boot scheduler (Track I, I2-b).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolveFeatureState,
  FEATURES,
  type FeatureId,
  type FeaturesConfig,
} from '../../../../src/shared/feature-registry'

// feature-gate transitively imports config → electron; keep it hermetic.
let featuresConfig: FeaturesConfig | undefined
let summaryRetry: Record<string, unknown> | undefined
const initializeVectorStore = vi.fn(async () => undefined)
const backfillMissingTranscripts = vi.fn(async () => ({ indexed: 0, skipped: 0 }))
vi.mock('../config', () => ({
  getConfig: () => ({ features: featuresConfig, transcription: { summaryRetry } }),
}))
vi.mock('../vector-store', () => ({
  getVectorStore: () => ({
    initialize: initializeVectorStore,
    backfillMissingTranscripts,
  }),
}))

const bootOrder = vi.hoisted(() => [] as string[])
vi.mock('../org-reconciler', () => ({
  reconcileOrganizationYielding: vi.fn(async () => {
    bootOrder.push('reconcile')
  }),
}))
vi.mock('../voice-learning', () => ({
  runVoiceLearning: vi.fn(async () => {
    bootOrder.push('voice-learning')
    return { ran: true }
  }),
}))
vi.mock('../identity-rules', () => ({
  runIdentityRules: vi.fn(async () => {
    bootOrder.push('identity-rules')
    return { ran: true }
  }),
}))

import { BOOT_TASK_DEFS, automaticSummaryRetryDue, healMissingSummaries, registerGatedBootTasks } from '../boot-tasks'

const ALL_TASK_NAMES = [
  'database-backup',
  'stale-auto-link-repair',
  'integrity-check',
  'org-reconcile',
  'knowledge-capture-backfill',
  'audio-profile-backfill', 'evaluation-warning-refresh', 'evaluation-catchup', 'kind-fallback',
  'transcript-sampling',
  'summary-reanalysis',
  'meeting-wiki-backfill',
  'start-transcription-processor',
  'semantic-index-restore',
]

/** Resolver-backed enable check for a given preset. */
function enabledUnder(features: FeaturesConfig): (id: FeatureId) => boolean {
  const resolved = resolveFeatureState(features)
  return (id) => resolved[id].enabled
}

beforeEach(() => {
  featuresConfig = undefined
  initializeVectorStore.mockClear()
  backfillMissingTranscripts.mockClear()
})

describe('BOOT_TASK_DEFS', () => {
  it('covers every deferred boot task in execution order', () => {
    expect(BOOT_TASK_DEFS.map((t) => t.name)).toEqual(ALL_TASK_NAMES)
  })

  it('every feature-owned task name is declared in that feature\'s registry backgroundTasks', () => {
    for (const def of BOOT_TASK_DEFS) {
      if (def.feature === null) continue
      expect(
        FEATURES[def.feature].backgroundTasks,
        `${def.name} must be listed under FEATURES['${def.feature}'].backgroundTasks`
      ).toContain(def.name)
    }
  })

  it('org-reconcile learns voices once the reconcile is done, then applies the identity rules (spec 2026-10-03, Phases 2 and 3)', async () => {
    bootOrder.length = 0
    await BOOT_TASK_DEFS.find((candidate) => candidate.name === 'org-reconcile')!.run()
    expect(bootOrder).toEqual(['reconcile', 'voice-learning', 'identity-rules'])
  })

  it('restores the existing semantic index without starting an embedding backfill', async () => {
    const task = BOOT_TASK_DEFS.find((candidate) => candidate.name === 'semantic-index-restore')
    expect(task).toBeDefined()

    await task!.run()

    expect(initializeVectorStore).toHaveBeenCalledOnce()
    expect(backfillMissingTranscripts).not.toHaveBeenCalled()
  })
})

describe('registerGatedBootTasks', () => {
  it('registers every task under the default full preset', () => {
    const registered: string[] = []
    const names = registerGatedBootTasks({
      isFeatureEnabled: enabledUnder({ preset: 'full', flags: {} }),
      register: (t) => registered.push(t.name),
    })
    expect(names).toEqual(ALL_TASK_NAMES)
    expect(registered).toEqual(ALL_TASK_NAMES)
  })

  it('library-only registers ZERO gated tasks — only the library-floor backfills', () => {
    const registered: string[] = []
    registerGatedBootTasks({
      isFeatureEnabled: enabledUnder({ preset: 'library-only', flags: {} }),
      register: (t) => registered.push(t.name),
    })
    expect(registered).toEqual(['database-backup', 'integrity-check', 'knowledge-capture-backfill', 'audio-profile-backfill', 'evaluation-warning-refresh'])
  })

  it('library-transcription adds exactly the three transcription tasks', () => {
    const registered: string[] = []
    registerGatedBootTasks({
      isFeatureEnabled: enabledUnder({ preset: 'library-transcription', flags: {} }),
      register: (t) => registered.push(t.name),
    })
    expect(registered).toEqual([
      'database-backup',
      'integrity-check',
      'knowledge-capture-backfill',
      'audio-profile-backfill', 'evaluation-warning-refresh', 'evaluation-catchup', 'kind-fallback',
      'transcript-sampling',
      'summary-reanalysis',
      'start-transcription-processor',
    ])
  })

  it('cascade gating: transcription off under full also stops the assistant semantic-index restore', () => {
    const registered: string[] = []
    registerGatedBootTasks({
      isFeatureEnabled: enabledUnder({ preset: 'full', flags: { transcription: false } }),
      register: (t) => registered.push(t.name),
    })
    // meeting-wiki (meeting-intelligence), transcription tasks and
    // semantic-index-restore (assistant) all drop via the requires:transcription cascade.
    expect(registered).toEqual(['database-backup', 'stale-auto-link-repair', 'integrity-check', 'org-reconcile', 'knowledge-capture-backfill', 'audio-profile-backfill', 'evaluation-warning-refresh'])
  })

  it('a disabled task NEVER runs — its run() body is not invoked', async () => {
    const ran: string[] = []
    const defs = BOOT_TASK_DEFS.map((d) => ({
      ...d,
      run: () => {
        ran.push(d.name)
      },
    }))
    const captured: Array<{ name: string; run: () => void | Promise<void> }> = []
    registerGatedBootTasks({
      isFeatureEnabled: enabledUnder({ preset: 'library-only', flags: {} }),
      register: (t) => captured.push(t),
      defs,
    })
    for (const t of captured) await t.run()
    expect(ran).toEqual(['database-backup', 'integrity-check', 'knowledge-capture-backfill', 'audio-profile-backfill', 'evaluation-warning-refresh'])
  })

  it('uses the live config-backed gate by default (mocked config here)', () => {
    featuresConfig = { preset: 'library-only', flags: {} }
    const registered: string[] = []
    registerGatedBootTasks({ register: (t) => registered.push(t.name) })
    expect(registered).toEqual(['database-backup', 'integrity-check', 'knowledge-capture-backfill', 'audio-profile-backfill', 'evaluation-warning-refresh'])
  })
})

describe('summary reanalysis (27-oct-2026)', () => {
  // A summary that failed leaves the transcript with no summary; this pass is
  // what fills it. Until now nothing in the app ever called it.
  it('heals up to three transcripts when the transcription queue is idle', async () => {
    const heal = vi.fn(async () => 2)
    expect(await healMissingSummaries({ queueBusy: () => false, heal })).toBe(2)
    expect(heal).toHaveBeenCalledWith(3, undefined)
  })

  it('takes as many per pass as Settings says, and passes the query through (28-oct-2026)', async () => {
    summaryRetry = { perPass: 7 }
    try {
      const heal = vi.fn(async () => 0)
      await healMissingSummaries({ queueBusy: () => false, heal }, { neverTried: true })
      expect(heal).toHaveBeenCalledWith(7, { neverTried: true })
    } finally {
      summaryRetry = undefined
    }
  })

  it('retries automatically only when switched on and the minutes have passed', () => {
    const now = Date.UTC(2026, 9, 28, 12)
    try {
      summaryRetry = { auto: true, everyMinutes: 30 }
      expect(automaticSummaryRetryDue(now, now - 29 * 60_000)).toBe(false)
      expect(automaticSummaryRetryDue(now, now - 30 * 60_000)).toBe(true)
      summaryRetry = { auto: false, everyMinutes: 30 }
      expect(automaticSummaryRetryDue(now, 0)).toBe(false)
      // Absent settings keep the earlier behaviour: on, every two hours.
      summaryRetry = undefined
      expect(automaticSummaryRetryDue(now, now - 119 * 60_000)).toBe(false)
      expect(automaticSummaryRetryDue(now, now - 120 * 60_000)).toBe(true)
    } finally {
      summaryRetry = undefined
    }
  })

  it('never runs two passes at once (review of #187)', async () => {
    let release!: () => void
    const heal = vi.fn(() => new Promise<number>((resolve) => { release = () => resolve(1) }))
    const first = healMissingSummaries({ queueBusy: () => false, heal })
    expect(await healMissingSummaries({ queueBusy: () => false, heal })).toBe(0)
    release()
    expect(await first).toBe(1)
    expect(heal).toHaveBeenCalledTimes(1)
    // Free again once the first pass is over.
    const again = healMissingSummaries({ queueBusy: () => false, heal })
    release()
    expect(await again).toBe(1)
  })

  it('waits while the queue is transcribing, so it never competes with it', async () => {
    const heal = vi.fn(async () => 1)
    expect(await healMissingSummaries({ queueBusy: () => true, heal })).toBe(0)
    expect(heal).not.toHaveBeenCalled()
  })
})
