import type { FeatureId } from '@/shared/feature-registry'

/**
 * True when a restart-gated feature (Device Sync, Assistant) was off when the
 * app started. Its IPC channels reject until the next launch (feature-gate.ts),
 * so callers skip them instead of collecting FeatureDisabledError rejections and
 * main-process error logs. Main passes the list when it creates the window.
 */
export function isFeatureOffThisRun(id: FeatureId): boolean {
  const list = typeof window !== 'undefined' ? window.electronAPI?.bootDisabledFeatures : undefined
  return Array.isArray(list) && list.includes(id)
}
