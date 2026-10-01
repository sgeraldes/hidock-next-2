/**
 * Put the pipeline in place once the database is open: the call ledger, the owner's plans, and the report of
 * the completions of the AI providers package (the graph and value calls) to the call being tracked.
 * The main process calls it with `run` and `queryAll` of `database.ts`; the headless brain host opens the
 * database read-only and runs no text step, so it installs neither.
 */
import { getConfig } from '../config'
import { installCallStore, type CallDb } from './call-store'
import { createConfigPlanSource } from './config-plans'
import { registerCompletionUsage } from './direct-calls'
import { listHarnessInfos } from './harness-info'
import { setPlanSource } from './plans'

export function installPipeline(db: CallDb): void {
  installCallStore(db)
  registerCompletionUsage()
  setPlanSource(createConfigPlanSource({ getPipeline: () => getConfig().pipeline, getHarnesses: listHarnessInfos }))
}
