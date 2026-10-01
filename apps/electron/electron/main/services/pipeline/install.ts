/**
 * Put the pipeline in place once the database is open: the call ledger and the owner's plans.
 * The main process calls it with `run` and `queryAll` of `database.ts`; the headless brain host opens the
 * database read-only and runs no text step, so it installs neither.
 */
import { getConfig } from '../config'
import { installCallStore, type CallDb } from './call-store'
import { createConfigPlanSource } from './config-plans'
import { listHarnessInfos } from './harness-info'
import { setPlanSource } from './plans'

export function installPipeline(db: CallDb): void {
  installCallStore(db)
  setPlanSource(createConfigPlanSource({ getPipeline: () => getConfig().pipeline, getHarnesses: listHarnessInfos }))
}
