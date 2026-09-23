/**
 * How a knowledge capture is read for anything that is not the owner's own
 * management UI: which columns, which rows are eligible, and what shape the
 * caller gets back.
 *
 * Moved out of ipc/knowledge-handlers.ts unchanged (2026-09-22) so a second
 * reader — the brain API that agents use — applies the SAME eligibility gate
 * instead of a copy of it. That gate is a privacy rule: it is what keeps a
 * capture derived from a recording the owner marked personal, deleted or
 * value-excluded out of every assistant and discovery surface. Two copies of
 * a privacy rule drift apart; one cannot.
 */

import {
  filterEligibleCaptureIds,
  existingRecordings,
  CAPTURE_VALUE_EXCLUDED_RATINGS
} from './recording-eligibility'
import type { KnowledgeCapture } from '@/types/knowledge'

// B-CHAT-007: Explicit column list instead of SELECT *
export const KNOWLEDGE_CAPTURE_COLUMNS = `id, title, user_title, summary, category, status, quality_rating, quality_confidence, quality_assessed_at, quality_reasons, quality_source, storage_tier, retention_days, expires_at, meeting_id, correlation_confidence, correlation_method, source_recording_id, captured_at, created_at, updated_at, deleted_at`

// =============================================================================
// ROUND-15 RESIDUAL (ADV14 follow-up) — knowledge-capture DISPLAY-tier gating.
//
// knowledge:getAll / getById / getByIds expose AI-derived capture summary+title
// to NON-EXEMPT assistant / discovery surfaces (ContextPicker, Chat,
// ActionableDetail, Projects). A capture DERIVED from an excluded recording
// (personal / soft-deleted / value-excluded / hard-purged) must NOT surface its
// summary/title there. Captures relate to a recording via `source_recording_id`;
// value-exclusion for recording-derived captures lives on the RECORDING via the
// shared positive allowlist (filterEligibleRecordingIds → getEligibleRecordingIds,
// which UNIONs personal/deleted with the F16 capture value predicate). A
// standalone (manual/artifact) capture has NO source recording and follows its
// own lifecycle — excluded only when its OWN quality_rating is value-excluded.
//
// TWO TIERS (round-14 pattern):
//  • DEFAULT (gated, assistant/DISPLAY-safe): recording-derived capture kept iff
//    its source recording is ELIGIBLE; standalone kept unless its own rating is
//    value-excluded; fail-closed → drop everything.
//  • OWNER (knowledge:getAllOwner, owner Library): recording-derived capture kept
//    iff its source recording ROW EXISTS (soft-deleted/personal/value-excluded
//    allowed so the owner can still see+manage their own value badges; hard-purged
//    / orphan dropped). Standalone handling is IDENTICAL to the gated tier — the
//    owner store slice (useUnifiedRecordings) is ALSO read by an assistant DISPLAY
//    surface (Today via useTodayCaptures, which surfaces standalone non-audio
//    captures), so standalone results MUST match the gate to avoid a value-gate
//    bypass on Today. The owner tier differs ONLY for recording-derived captures,
//    which are audio and never shown on Today.
// =============================================================================

/** Raw capture row shape the eligibility gate needs (rest of the columns pass through). */
export type CaptureRow = { id: string; source_recording_id: string | null; quality_rating: string | null; [k: string]: unknown }

/**
 * Apply the capture eligibility gate to a batch of raw capture rows.
 *
 * GATED (assistant/DISPLAY-safe) routes EVERY row through the ONE shared central
 * capture boundary {@link filterEligibleCaptureIds} (ADV15) — deleted_at +
 * recording-derived delegation to the recording allowlist + standalone value
 * quality, all fail-closed. This replaces the round-15b per-handler predicate
 * (which never checked the capture's own `deleted_at`, ADV15-2).
 *
 * OWNER is the narrow existence-scoped exemption for the owner Library: a
 * recording-derived capture is kept when its source recording ROW EXISTS
 * (soft-deleted/personal/value-excluded allowed so the owner sees their own value
 * badges; hard-purged/orphan dropped). Standalone captures use the SAME shared
 * value-excluded set as the gated boundary so the store slice's assistant DISPLAY
 * consumer (Today) can't leak value-excluded standalone captures.
 *
 * Any eligibility-lookup failure → failClosed=true with an empty kept set.
 */
export function applyCaptureEligibility(rows: CaptureRow[], tier: 'gated' | 'owner'): { kept: CaptureRow[]; failClosed: boolean } {
  if (rows.length === 0) return { kept: [], failClosed: false }
  if (tier === 'gated') {
    const { eligible, failClosed } = filterEligibleCaptureIds(rows.map((r) => r.id))
    if (failClosed) return { kept: [], failClosed: true }
    return { kept: rows.filter((r) => eligible.has(r.id)), failClosed: false }
  }
  // OWNER tier — existence-scoped for RECORDING-DERIVED captures only. ADV16-1
  // (round-17): the owner relaxation must NOT extend to STANDALONE captures.
  // getAllOwner feeds the app-wide unified-recordings store and Today renders
  // non-audio STANDALONE captures, so a soft-deleted standalone capture kept here
  // would reappear on Today OUTSIDE Trash. Standalone captures therefore go
  // through FULL capture eligibility (deleted_at IS NULL AND own quality not
  // value-excluded) — identical to the gated tier — while recording-derived
  // captures keep the existence-scope (owner Library legitimately sees excluded
  // recordings, which are audio and never shown on Today).
  const sourceIds = rows.map((r) => r.source_recording_id).filter((id): id is string => !!id)
  const res = existingRecordings(sourceIds)
  if (res.failClosed) return { kept: [], failClosed: true }
  const kept = rows.filter((r) =>
    r.source_recording_id
      ? res.ids.has(r.source_recording_id)
      : r.deleted_at == null && !CAPTURE_VALUE_EXCLUDED_RATINGS.has(r.quality_rating ?? '')
  )
  return { kept, failClosed: false }
}

function safeParseReasons(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Mapper from DB snake_case to Interface camelCase
export function mapToKnowledgeCapture(row: any): KnowledgeCapture {
  return {
    id: row.id,
    userTitle: row.user_title,
    title: row.title,
    summary: row.summary,
    category: row.category,
    status: row.status,
    quality: row.quality_rating,
    qualityConfidence: row.quality_confidence,
    qualityAssessedAt: row.quality_assessed_at,
    qualityReasons: safeParseReasons(row.quality_reasons),
    qualitySource: row.quality_source,
    storageTier: row.storage_tier,
    retentionDays: row.retention_days,
    expiresAt: row.expires_at,
    meetingId: row.meeting_id,
    correlationConfidence: row.correlation_confidence,
    correlationMethod: row.correlation_method,
    sourceRecordingId: row.source_recording_id,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  }
}
