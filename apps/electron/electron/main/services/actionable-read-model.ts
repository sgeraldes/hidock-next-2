/**
 * How an actionable is read for assistant and discovery surfaces: which rows
 * are eligible, and what shape the caller gets back.
 *
 * Moved out of ipc/actionables-handlers.ts unchanged (2026-09-22) so the brain
 * API that agents use applies the SAME gate as the app, rather than a copy.
 */

import { filterEligibleActionableRows } from './actionable-eligibility'
import type { Actionable } from '@/types/knowledge'

/**
 * ADV15 (round-16) — actionables lists route through the ONE shared capture-aware
 * boundary {@link filterEligibleActionableRows}. It resolves each row's
 * `source_knowledge_id` to a live capture (gated via filterEligibleCaptureIds:
 * deleted_at + recording-derived delegation + standalone quality) or, for legacy
 * rows, a recording id (filterEligibleRecordingIds); truly standalone actionables
 * (null source) are kept. This replaces the round-7 per-handler predicate that
 * unconditionally kept null-source (standalone) captures (ADV15-3).
 */
export const gateActionables = <T extends { source_knowledge_id?: string | null }>(rows: T[]): T[] =>
  filterEligibleActionableRows(rows, (r) => r.source_knowledge_id)

export function mapToActionable(row: any): Actionable {
  let recipients: string[] = []
  if (row.suggested_recipients) {
    try {
      recipients = JSON.parse(row.suggested_recipients)
    } catch {
      recipients = []
    }
  }

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    sourceKnowledgeId: row.source_knowledge_id,
    sourceActionItemId: row.source_action_item_id,
    suggestedTemplate: row.suggested_template,
    suggestedRecipients: recipients,
    status: row.status,
    confidence: row.confidence,
    artifactId: row.artifact_id,
    generatedAt: row.generated_at,
    sharedAt: row.shared_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
