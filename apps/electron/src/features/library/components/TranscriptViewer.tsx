/**
 * TranscriptViewer Component
 *
 * A reusable component for displaying transcripts with interactive timestamps.
 * Parses timestamps, renders TimeAnchor components, highlights the current segment,
 * and auto-scrolls during playback.
 */

import { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import { TimeAnchor } from './TimeAnchor'
import { SpeakerAssignPopover, type AssignScope } from './SpeakerAssignPopover'
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Pencil,
  RefreshCw,
  TriangleAlert,
  X
} from 'lucide-react'
import { expandInlineStoredSegments } from '../utils/splitInlineTurns'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { BusyIcon } from '@/components/ui/working'
import type { Person } from '@/types/knowledge'
import { lineIssues, isJumpableLineIssue, type LineIssueCode } from '@/shared/transcript-line-issues'
import { ISSUE_TAGS } from '../utils/transcriptIntegrity'
import { formatTimestamp, parseTypedTime } from '../utils/formatTimestamp'

/** Stored transcript segment (from the `speakers` JSON column). Times in seconds. */
export interface StoredSegment {
  speaker?: string
  start: number
  end?: number
  text: string
  speakerAttribution?: string
  speakerConfidence?: number
}

interface TranscriptViewerProps {
  transcript: string
  currentTimeMs?: number
  onSeek: (startMs: number, endMs?: number) => void
  showSummary?: boolean
  showActionItems?: boolean
  showTranscriptHeader?: boolean
  summary?: string
  actionItems?: string[]
  /**
   * Pre-parsed speaker/timestamp segments (e.g. from Gemini's structured
   * output or local ASR). When present, these are rendered directly as turns
   * instead of re-parsing the plain `transcript` string.
   */
  segments?: StoredSegment[]
  /**
   * When provided, speaker labels become interactive: each can be assigned to a
   * canonical contact (existing or new). Assignments are resolved through the
   * recording's speaker map so every turn with the same label renders the
   * person's name. Omit to render labels as plain, non-interactive text.
   */
  recordingId?: string
  /**
   * Whether the audio for this transcript is currently playing. When explicitly
   * `false`, there is no live playback position to follow, so:
   *  - auto-scroll does not yank the view to a stale/last segment, and
   *  - clicking "Follow" jumps to the TOP of the transcript (position 0)
   *    instead of the current (often end-of-file) segment.
   * Left `undefined` (e.g. MeetingDetail) preserves the legacy follow behavior.
   */
  isPlaying?: boolean
  /**
   * Cross-highlight request from the meeting-timeline markers: when a numbered
   * marker (or its event-list row) is clicked, the reader asks the transcript to
   * scroll to + briefly pulse the turn at `atMs`. `nonce` re-triggers the pulse
   * even when the same marker is clicked twice. Only meaningful for timestamped
   * transcripts (a fabricated action-item time can't map to a real turn → no-op).
   */
  highlightRequest?: { atMs: number; nonce: number } | null
  /**
   * Go to the next line with this problem (after the last one jumped to, wrapping
   * around), scroll it into view and flash it. From the integrity panel labels.
   */
  issueJump?: { code: LineIssueCode; nonce: number } | null
  /** Mirrors a successful persisted correction into the owning reader state. */
  onTranscriptUpdated?: (update: TranscriptContentUpdate) => void
}

export interface TranscriptContentUpdate {
  fullText: string
  segments: StoredSegment[]
  wordCount: number
  /** The timing check on the saved lines, when the main process ran it. */
  integrity?: { status: 'ok' | 'suspect' | 'broken'; json: string }
}

interface TranscriptSegment {
  startMs: number
  endMs?: number
  text: string
  speaker?: string
  /** Carried from storage so saving a correction keeps them. */
  speakerAttribution?: string
  speakerConfidence?: number
}

/** A speaker split loaded from the backend (base label forked from a turn on). */
interface SpeakerSplit {
  baseLabel: string
  fromIndex: number
  derivedLabel: string
}

/**
 * The effective label for a turn: if a split for this base label begins at or
 * before this turn, the derived label of the latest such boundary; else the raw
 * base label. Splits are matched only against the turn's own base label so an
 * unrelated speaker's split never leaks across.
 */
function effectiveLabelFor(baseLabel: string, turnIndex: number, splits: SpeakerSplit[]): string {
  let best: SpeakerSplit | undefined
  for (const s of splits) {
    if (s.baseLabel !== baseLabel) continue
    if (s.fromIndex <= turnIndex && (!best || s.fromIndex > best.fromIndex)) best = s
  }
  return best ? best.derivedLabel : baseLabel
}

/**
 * Break a plain, unstructured transcript into readable paragraphs so an
 * old-style single-blob transcript (no newlines, no speaker labels) doesn't
 * render as one unbroken wall of text. Splits on existing newlines first, then
 * subdivides any long run into ~sentence groups.
 */
function toParagraphs(text: string): string[] {
  const paragraphs: string[] = []
  for (const block of text.split(/\n+/).map((b) => b.trim()).filter(Boolean)) {
    if (block.length <= 600) {
      paragraphs.push(block)
      continue
    }
    const sentences = block.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [block]
    let current = ''
    for (const sentence of sentences) {
      current += sentence
      if (current.length >= 350) {
        paragraphs.push(current.trim())
        current = ''
      }
    }
    if (current.trim()) paragraphs.push(current.trim())
  }
  return paragraphs.length > 0 ? paragraphs : [text.trim()]
}

/** Map stored (seconds-based) segments to the viewer's internal ms-based shape.
 * Legacy segments that packed a whole chunk into one text blob with inline
 * `[MM:SS] Speaker N:` markers are first re-split into individual turns so they
 * render correctly without re-transcription. */
function fromStoredSegments(stored: StoredSegment[]): TranscriptSegment[] {
  return expandInlineStoredSegments(stored)
    .filter((s) => s.text?.trim())
    .map((s) => ({
      startMs: Math.round((s.start || 0) * 1000),
      endMs: s.end != null ? Math.round(s.end * 1000) : undefined,
      speaker: s.speaker,
      text: s.text.trim(),
      ...(s.speakerAttribution ? { speakerAttribution: s.speakerAttribution } : {}),
      ...(typeof s.speakerConfidence === 'number' ? { speakerConfidence: s.speakerConfidence } : {})
    }))
}

/**
 * Parse speaker name from text. Supports, at the start of the text:
 *   **Speaker Name:**   / **Speaker Name**:   / **Speaker Name**   (markdown-bold)
 *   [Speaker Name]
 *   Speaker Name:
 */
function parseSpeaker(text: string): { speaker: string | undefined; remainingText: string } {
  const trimmed = text.trimStart()

  // Markdown-bold label: **Name:** rest / **Name**: rest / **Name** rest
  // [^*\n]+? captures the name (and any inner colon); trailing colon is stripped below.
  const boldMatch = trimmed.match(/^\*\*\s*([^*\n]+?)\s*\*\*\s*:?\s*([\s\S]*)$/)
  if (boldMatch) {
    return { speaker: boldMatch[1].replace(/:\s*$/, '').trim(), remainingText: boldMatch[2].trim() }
  }

  // "[Speaker Name]" format
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]\s*([\s\S]*)$/)
  if (bracketMatch) {
    return { speaker: bracketMatch[1].trim(), remainingText: bracketMatch[2].trim() }
  }

  // "Speaker Name:" format (capitalised, no colon inside the name)
  const colonMatch = trimmed.match(/^([A-Z][^:\n]*?):\s+([\s\S]*)$/)
  if (colonMatch) {
    return { speaker: colonMatch[1].trim(), remainingText: colonMatch[2].trim() }
  }

  return { speaker: undefined, remainingText: text }
}

// A line that begins a new speaker turn (markdown-bold, bracket, or "Name:").
const SPEAKER_LINE_REGEX = /^[ \t]*(?:\*\*[^*\n]+\*\*\s*:?|\[[^\]\n]+\]|[A-Z][^:\n]{0,40}?:)\s/

/**
 * Parse a transcript with no timestamps into speaker turns. Each turn starts at
 * a line with a speaker label; continuation lines are appended to the turn.
 * Returns a single plain segment when no speaker labels are present.
 */
function parseSpeakerSegments(transcript: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  let current: TranscriptSegment | null = null

  for (const line of transcript.split('\n')) {
    if (SPEAKER_LINE_REGEX.test(line)) {
      if (current) segments.push(current)
      const { speaker, remainingText } = parseSpeaker(line)
      current = { startMs: 0, speaker, text: remainingText }
    } else if (current) {
      current.text += line.trim() ? `\n${line.trim()}` : ''
    } else if (line.trim()) {
      current = { startMs: 0, text: line.trim() }
    }
  }
  if (current) segments.push(current)

  return segments.length > 0 ? segments : [{ startMs: 0, text: transcript.trim() }]
}

/**
 * Parse timestamps from transcript text.
 * Supports formats: [MM:SS], [HH:MM:SS], MM:SS, HH:MM:SS
 */
function parseTimestamp(timestampStr: string): number | null {
  // Remove brackets if present
  const cleaned = timestampStr.replace(/[[\]]/g, '').trim()

  // Split by colons
  const parts = cleaned.split(':').map(part => parseInt(part, 10))

  if (parts.some(isNaN)) {
    return null
  }

  let totalSeconds = 0

  if (parts.length === 2) {
    // MM:SS format
    const [minutes, seconds] = parts
    totalSeconds = minutes * 60 + seconds
  } else if (parts.length === 3) {
    // HH:MM:SS format
    const [hours, minutes, seconds] = parts
    totalSeconds = hours * 3600 + minutes * 60 + seconds
  } else {
    return null
  }

  return totalSeconds * 1000 // Convert to milliseconds
}

/**
 * Parse transcript into segments with timestamps.
 * Detects timestamps in formats: [MM:SS], [HH:MM:SS], bare MM:SS, HH:MM:SS at line start
 */
function parseTranscriptSegments(transcript: string): { segments: TranscriptSegment[]; hasTimestamps: boolean } {
  const segments: TranscriptSegment[] = []

  // Timestamps at the start of a line (with optional brackets):
  // [00:15], [00:15:30], 00:15, 00:15:30. A line without one continues the turn
  // above; text before the first timestamp is its own turn at 0. Saving a
  // correction rebuilds the whole transcript from these turns, so no line may
  // be dropped here (review 28-sep-2026: continuation lines were deleted).
  const timestampLine = /^(\[?\d{1,2}:\d{2}(?::\d{2})?\]?)\s+(.*)$/
  const preamble: string[] = []
  let sawTimestamp = false

  for (const line of transcript.split(/\r?\n/)) {
    const match = timestampLine.exec(line)
    const startMs = match ? parseTimestamp(match[1]) : null
    if (match && startMs !== null) {
      sawTimestamp = true
      if (segments.length > 0) segments[segments.length - 1].endMs = startMs
      const { speaker, remainingText } = parseSpeaker(match[2].trim())
      segments.push({ startMs, text: remainingText, speaker })
      continue
    }
    const text = line.trim()
    if (!text) continue
    if (!sawTimestamp) preamble.push(text)
    else segments[segments.length - 1].text = `${segments[segments.length - 1].text}\n${text}`.trim()
  }
  if (sawTimestamp && preamble.length > 0) {
    segments.unshift({ startMs: 0, endMs: segments[0]?.startMs, text: preamble.join('\n') })
  }

  if (segments.length > 0) {
    return { segments, hasTimestamps: true }
  }

  // No timestamps — fall back to speaker-turn parsing (handles **Name:** etc.)
  return { segments: parseSpeakerSegments(transcript), hasTimestamps: false }
}

/** The start time as the edit field shows it: 1:05, or 1:05.4 when it has tenths. */
function formatEditableTime(ms: number): string {
  const tenths = Math.round(ms / 100) % 10
  return tenths ? `${formatTimestamp(ms / 1000)}.${tenths}` : formatTimestamp(ms / 1000)
}

export function TranscriptViewer({
  transcript,
  currentTimeMs,
  onSeek,
  showSummary = true,
  showActionItems = true,
  showTranscriptHeader = true,
  summary,
  actionItems,
  segments: storedSegments,
  recordingId,
  isPlaying,
  highlightRequest,
  issueJump,
  onTranscriptUpdated
}: TranscriptViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeSegmentRef = useRef<HTMLDivElement | null>(null)
  const pulseSegmentRef = useRef<HTMLDivElement | null>(null)
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [summaryExpanded, setSummaryExpanded] = useState(true)
  const [actionItemsExpanded, setActionItemsExpanded] = useState(true)
  const [transcriptExpanded, setTranscriptExpanded] = useState(true)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editStart, setEditStart] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [savingIndex, setSavingIndex] = useState<number | null>(null)
  const [ragPending, setRagPending] = useState<string | null>(null)
  const [retryingRag, setRetryingRag] = useState(false)

  // Cross-highlight: the turn briefly pulsed after a timeline marker click.
  // Carries the request's nonce so a rapid repeat click on the SAME turn is a
  // state CHANGE — the scroll/timer effect below re-runs and the pulse restarts
  // (a bare index would be a same-value setState → no re-run, stale timer).
  const [pulse, setPulse] = useState<{ index: number; nonce: number } | null>(null)

  // Auto-follow: while audio plays, keep the current turn in view. We must not
  // fight the user — a manual scroll pauses following until the next play or an
  // explicit "Follow" tap. Reduced-motion users get instant (non-smooth) jumps.
  const [autoFollow, setAutoFollow] = useState(true)
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const prevTimeMsRef = useRef<number | undefined>(undefined)

  // Speaker → contact assignment. Only active when a recordingId is supplied.
  // speakerMap resolves a label ("Speaker 2", or a split-derived "Speaker 2 · B")
  // to its assigned contact; turnOverrides supersede the label default for a
  // single turn; splits fork a merged label from a turn onward. The contacts
  // list backs the popover's searchable picker (loaded lazily).
  const assignEnabled = Boolean(recordingId)
  const [speakerMap, setSpeakerMap] = useState<Map<string, { contactId: string; name: string }>>(new Map())
  const [turnOverrides, setTurnOverrides] = useState<Map<number, { contactId: string; name: string }>>(new Map())
  const [splits, setSplits] = useState<SpeakerSplit[]>([])
  const [mergeHints, setMergeHints] = useState<Set<string>>(new Set())
  const [contacts, setContacts] = useState<Person[]>([])
  const [contactsLoaded, setContactsLoaded] = useState(false)

  const loadSpeakerMap = useCallback(async () => {
    if (!recordingId) {
      setSpeakerMap(new Map())
      return
    }
    try {
      const res = await window.electronAPI.transcripts.getSpeakerMap({ recordingId })
      if (res.success) {
        const next = new Map<string, { contactId: string; name: string }>()
        for (const row of res.data) next.set(row.speaker_label, { contactId: row.contact_id, name: row.name })
        setSpeakerMap(next)
      }
    } catch {
      // Non-fatal: labels simply render un-resolved.
    }
  }, [recordingId])

  const loadTurnOverrides = useCallback(async () => {
    if (!recordingId) {
      setTurnOverrides(new Map())
      return
    }
    try {
      const res = await window.electronAPI.turnSpeakers.getOverrides({ recordingId })
      if (res.success) {
        const next = new Map<number, { contactId: string; name: string }>()
        for (const row of res.data) next.set(row.turn_index, { contactId: row.contact_id, name: row.name })
        setTurnOverrides(next)
      }
    } catch {
      // Non-fatal: turns fall back to their label default.
    }
  }, [recordingId])

  const loadSplits = useCallback(async () => {
    if (!recordingId) {
      setSplits([])
      return
    }
    try {
      const res = await window.electronAPI.turnSpeakers.getSplits({ recordingId })
      if (res.success) {
        setSplits(res.data.map((r) => ({ baseLabel: r.base_label, fromIndex: r.from_turn_index, derivedLabel: r.derived_label })))
      }
    } catch {
      // Non-fatal: labels render un-split.
    }
  }, [recordingId])

  const loadMergeHints = useCallback(async () => {
    if (!recordingId) {
      setMergeHints(new Set())
      return
    }
    try {
      const res = await window.electronAPI.turnSpeakers.getMergeHints({ recordingId })
      if (res.success) setMergeHints(new Set(res.data.map((h) => h.label)))
    } catch {
      // Non-fatal: no hint shown.
    }
  }, [recordingId])

  useEffect(() => {
    loadSpeakerMap()
    loadTurnOverrides()
    loadSplits()
    loadMergeHints()
  }, [loadSpeakerMap, loadTurnOverrides, loadSplits, loadMergeHints])

  const ensureContacts = useCallback(async () => {
    if (contactsLoaded) return
    try {
      const res = await window.electronAPI.contacts.getAll()
      if (res.success) setContacts(res.data.contacts)
    } catch {
      // Non-fatal: picker shows an empty list, create-new still works.
    } finally {
      setContactsLoaded(true)
    }
  }, [contactsLoaded])

  // Assign this turn's speaker at the chosen scope: "everywhere" binds the
  // (effective) label, "turn" overrides only this turn, "fromHere" splits the
  // base label at this turn and binds the derived half.
  const assignSpeakerScoped = useCallback(
    async (
      scope: AssignScope,
      ctx: { effectiveLabel: string; baseLabel: string; turnIndex: number },
      payload: { contactId?: string; newName?: string }
    ) => {
      if (!recordingId) return
      try {
        if (scope === 'turn') {
          const res = await window.electronAPI.turnSpeakers.setOverride({ recordingId, turnIndex: ctx.turnIndex, ...payload })
          if (!res.success) return toast.error('Failed to assign speaker')
          await loadTurnOverrides()
          setContactsLoaded(false)
          toast.success('Turn assigned', `This turn is now ${res.data.name}.`)
        } else if (scope === 'fromHere') {
          const res = await window.electronAPI.turnSpeakers.assignFromHere({
            recordingId,
            baseLabel: ctx.baseLabel,
            fromTurnIndex: ctx.turnIndex,
            ...payload
          })
          if (!res.success) return toast.error('Failed to assign speaker')
          await Promise.all([loadSplits(), loadSpeakerMap()])
          setContactsLoaded(false)
          toast.success('Speaker split', `From here on is now ${res.data.contact.name}.`)
        } else {
          const res = await window.electronAPI.transcripts.assignSpeaker({
            recordingId,
            speakerLabel: ctx.effectiveLabel,
            ...payload
          })
          if (!res.success) return toast.error('Failed to assign speaker')
          await loadSpeakerMap()
          setContactsLoaded(false)
          toast.success('Speaker assigned', `${ctx.effectiveLabel} is now ${res.data.name}.`)
        }
      } catch (err) {
        toast.error('Failed to assign speaker', err instanceof Error ? err.message : undefined)
      }
    },
    [recordingId, loadSpeakerMap, loadTurnOverrides, loadSplits]
  )

  // Clear the effective assignment for a turn: its per-turn override if present,
  // else the (effective) label binding.
  const unassignSpeakerScoped = useCallback(
    async (ctx: { effectiveLabel: string; turnIndex: number; hasOverride: boolean }) => {
      if (!recordingId) return
      try {
        if (ctx.hasOverride) {
          const res = await window.electronAPI.turnSpeakers.clearOverride({ recordingId, turnIndex: ctx.turnIndex })
          if (!res.success) return toast.error('Failed to reset turn')
          await loadTurnOverrides()
          toast.success('Turn reset')
        } else {
          const res = await window.electronAPI.transcripts.unassignSpeaker({ recordingId, speakerLabel: ctx.effectiveLabel })
          if (!res.success) return toast.error('Failed to unassign speaker')
          await loadSpeakerMap()
          toast.success('Speaker unassigned')
        }
      } catch (err) {
        toast.error('Failed to unassign speaker', err instanceof Error ? err.message : undefined)
      }
    },
    [recordingId, loadSpeakerMap, loadTurnOverrides]
  )

  const splitSpeaker = useCallback(
    async (baseLabel: string, fromTurnIndex: number) => {
      if (!recordingId) return
      try {
        const res = await window.electronAPI.turnSpeakers.split({ recordingId, baseLabel, fromTurnIndex })
        if (!res.success) return toast.error('Failed to split speaker')
        await loadSplits()
        toast.success('Speaker split', `Turns from here are now ${res.data.derivedLabel}.`)
      } catch (err) {
        toast.error('Failed to split speaker', err instanceof Error ? err.message : undefined)
      }
    },
    [recordingId, loadSplits]
  )

  const mergeSplit = useCallback(
    async (baseLabel: string, fromTurnIndex: number) => {
      if (!recordingId) return
      try {
        const res = await window.electronAPI.turnSpeakers.mergeSplit({ recordingId, baseLabel, fromTurnIndex })
        if (!res.success) return toast.error('Failed to merge speaker')
        await Promise.all([loadSplits(), loadSpeakerMap()])
        toast.success('Merged back', `Rejoined ${baseLabel}.`)
      } catch (err) {
        toast.error('Failed to merge speaker', err instanceof Error ? err.message : undefined)
      }
    },
    [recordingId, loadSplits, loadSpeakerMap]
  )

  // Prefer pre-parsed segments (timestamped speaker turns) when available;
  // otherwise parse the plain transcript string (timestamped or speaker-turn based).
  const parsedTranscript = useMemo(() => {
    if (storedSegments && storedSegments.length > 0) {
      const mapped = fromStoredSegments(storedSegments)
      if (mapped.length > 0) {
        return { segments: mapped, hasTimestamps: mapped.some((s) => s.startMs > 0) }
      }
    }
    return parseTranscriptSegments(transcript)
  }, [storedSegments, transcript])
  const [localSegments, setLocalSegments] = useState<TranscriptSegment[] | null>(null)
  const [persistedFullText, setPersistedFullText] = useState(transcript)
  // The stored segments this editor started from, sent with a save so the main
  // process refuses it when someone else changed a time in the meantime.
  const [persistedStored, setPersistedStored] = useState<StoredSegment[] | null>(storedSegments ?? null)
  const latestTranscriptRef = useRef(transcript)
  latestTranscriptRef.current = transcript
  const latestStoredRef = useRef(storedSegments)
  latestStoredRef.current = storedSegments
  const segments = localSegments ?? parsedTranscript.segments
  const hasTimestamps = localSegments
    ? localSegments.some((segment) => segment.startMs > 0)
    : parsedTranscript.hasTimestamps

  useEffect(() => {
    setLocalSegments(null)
    setPersistedFullText(latestTranscriptRef.current)
    setPersistedStored(latestStoredRef.current ?? null)
    setEditingIndex(null)
    setEditDraft('')
    setEditStart('')
    setEditError(null)
    setRagPending(null)
  }, [recordingId])

  // Problems per line, with the same rules the integrity warning counts.
  const issuesByLine = useMemo<LineIssueCode[][]>(
    () =>
      hasTimestamps
        ? lineIssues(
            segments.map((s) => ({
              start: s.startMs / 1000,
              end: s.endMs !== undefined ? s.endMs / 1000 : null,
              text: s.text
            }))
          ).map((codes) => codes.filter(isJumpableLineIssue))
        : [],
    [segments, hasTimestamps]
  )

  const editEnabled = Boolean(recordingId && window.electronAPI?.transcripts?.updateContent)

  const startEditing = useCallback((index: number) => {
    setAutoFollow(false)
    setEditingIndex(index)
    setEditDraft(segments[index]?.text ?? '')
    setEditStart(formatEditableTime(segments[index]?.startMs ?? 0))
    setEditError(null)
  }, [segments])

  const cancelEditing = useCallback(() => {
    if (savingIndex !== null) return
    setEditingIndex(null)
    setEditDraft('')
    setEditStart('')
    setEditError(null)
  }, [savingIndex])

  const saveCorrection = useCallback(async () => {
    if (!recordingId || editingIndex === null || savingIndex !== null) return
    const corrected = editDraft.trim()
    if (!corrected) {
      setEditError('A transcript turn cannot be empty.')
      return
    }
    const editedSegment = segments[editingIndex]
    let startSec = editedSegment ? editedSegment.startMs / 1000 : 0
    if (hasTimestamps) {
      const parsed = parseTypedTime(editStart)
      if (parsed === null) {
        setEditError('The time must look like 1:05, 1:05.5 or 1:02:03.')
        return
      }
      startSec = parsed
    }
    const timeChanged = hasTimestamps && editedSegment
      ? Math.round(startSec * 10) !== Math.round(editedSegment.startMs / 100)
      : false
    if (corrected === editedSegment?.text.trim() && !timeChanged) {
      cancelEditing()
      return
    }
    // A moved line keeps its length: the end moves by the same amount.
    const shiftSec = timeChanged && editedSegment ? startSec - editedSegment.startMs / 1000 : 0

    const nextSegments = segments.map((segment, index) => ({
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
      start: index === editingIndex && timeChanged ? startSec : segment.startMs / 1000,
      ...(segment.endMs !== undefined
        ? { end: index === editingIndex && timeChanged ? Math.max(startSec, segment.endMs / 1000 + shiftSec) : segment.endMs / 1000 }
        : {}),
      text: index === editingIndex ? corrected : segment.text,
      ...(segment.speakerAttribution ? { speakerAttribution: segment.speakerAttribution } : {}),
      ...(segment.speakerConfidence !== undefined ? { speakerConfidence: segment.speakerConfidence } : {})
    }))

    setSavingIndex(editingIndex)
    setEditError(null)
    try {
      const result = await window.electronAPI.transcripts.updateContent({
        recordingId,
        expectedFullText: persistedFullText,
        expectedSegments: persistedStored,
        segments: nextSegments
      })
      if (!result.success) {
        setEditError(result.error.message)
        toast.error('Could not save transcript correction', result.error.message)
        return
      }

      const mapped = fromStoredSegments(result.data.segments)
      setLocalSegments(mapped)
      setPersistedFullText(result.data.fullText)
      setPersistedStored(result.data.segments.length > 0 ? result.data.segments : null)
      setEditingIndex(null)
      setEditDraft('')
      setEditStart('')
      onTranscriptUpdated?.({
        fullText: result.data.fullText,
        segments: result.data.segments,
        wordCount: result.data.wordCount,
        ...(result.data.integrity ? { integrity: result.data.integrity } : {})
      })

      if (result.data.ragStatus === 'indexed') {
        setRagPending(null)
        toast.success(
          'Transcript and RAG updated',
          `${result.data.indexedChunks} search chunk${result.data.indexedChunks === 1 ? '' : 's'} regenerated.`
        )
      } else {
        setRagPending(result.data.ragError ?? 'The embedding provider did not rebuild the search index.')
        toast.error(
          'Transcript saved; RAG update pending',
          result.data.ragError ?? 'Use Retry RAG when the embedding provider is available.'
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The correction could not be saved.'
      setEditError(message)
      toast.error('Could not save transcript correction', message)
    } finally {
      setSavingIndex(null)
    }
  }, [cancelEditing, editDraft, editStart, editingIndex, hasTimestamps, onTranscriptUpdated, persistedFullText, persistedStored, recordingId, savingIndex, segments])

  const retryRag = useCallback(async () => {
    if (!recordingId || retryingRag) return
    setRetryingRag(true)
    try {
      const result = await window.electronAPI.transcripts.reindex({ recordingId })
      if (!result.success) {
        setRagPending(result.error.message)
        toast.error('RAG update still pending', result.error.message)
        return
      }
      setRagPending(null)
      toast.success(
        'RAG updated',
        `${result.data.indexedChunks} search chunk${result.data.indexedChunks === 1 ? '' : 's'} regenerated.`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The RAG index could not be updated.'
      setRagPending(message)
      toast.error('RAG update still pending', message)
    } finally {
      setRetryingRag(false)
    }
  }, [recordingId, retryingRag])

  // Find current segment index based on currentTimeMs (only meaningful with timestamps)
  const currentSegmentIndex = useMemo(() => {
    if (!hasTimestamps || currentTimeMs === undefined) return -1

    return segments.findIndex((seg, i) => {
      const isAfterStart = currentTimeMs >= seg.startMs
      const isBeforeEnd = i === segments.length - 1 || (seg.endMs && currentTimeMs < seg.endMs)
      return isAfterStart && isBeforeEnd
    })
  }, [segments, currentTimeMs, hasTimestamps])

  // Find the turn whose time span COVERS a given audio offset (ms), using
  // half-open coverage: startMs ≤ ms < end. A turn's end is its own endMs, else
  // the NEXT turn's startMs (turns abut when no explicit end was stored), else —
  // only for the final turn with no evidence of an end — unbounded. Precedence
  // when spans overlap: the LATEST turn (by index) that covers `ms` wins, since
  // markers are anchored to turn STARTS, so the most-recently-started covering
  // turn is the marker's source. Returns -1 (no match) for offsets in a real
  // gap between known spans, before the first turn, or past the final turn's
  // known end — never highlights unrelated text.
  const findSegmentIndexAtMs = useCallback(
    (ms: number): number => {
      if (!hasTimestamps || segments.length === 0 || !Number.isFinite(ms)) return -1
      let match = -1
      for (let i = 0; i < segments.length; i++) {
        const start = segments[i].startMs
        if (start > ms) continue
        const end = segments[i].endMs ?? (i + 1 < segments.length ? segments[i + 1].startMs : Infinity)
        if (ms < end) match = i
      }
      return match
    },
    [hasTimestamps, segments]
  )

  // React to a cross-highlight request from the timeline markers: resolve the
  // matching turn, expand + stop auto-follow so the jump isn't fought, and mark
  // it for the pulse. Keyed on the nonce so re-clicking the same marker re-fires
  // — the nonce travels into the pulse state so even a same-turn repeat is a
  // state change (the scroll/timer effect below restarts).
  useEffect(() => {
    if (!highlightRequest) return
    const idx = findSegmentIndexAtMs(highlightRequest.atMs)
    if (idx < 0) return
    setTranscriptExpanded(true)
    setAutoFollow(false)
    setPulse({ index: idx, nonce: highlightRequest.nonce })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRequest?.nonce])

  // Jump to the next line with the requested problem. Each code remembers where
  // it last jumped, so repeated clicks walk through all of them and wrap.
  const lastIssueJumpRef = useRef<Partial<Record<LineIssueCode, number>>>({})
  useEffect(() => {
    if (!issueJump) return
    const flagged = issuesByLine
      .map((codes, index) => (codes.includes(issueJump.code) ? index : -1))
      .filter((index) => index >= 0)
    if (flagged.length === 0) {
      toast.info('No line has this problem now', 'The warning was measured before a later change. HiDock measures it again the next time it starts.')
      return
    }
    const last = lastIssueJumpRef.current[issueJump.code] ?? -1
    const next = flagged.find((index) => index > last) ?? flagged[0]
    lastIssueJumpRef.current[issueJump.code] = next
    setTranscriptExpanded(true)
    setAutoFollow(false)
    setPulse({ index: next, nonce: issueJump.nonce })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueJump?.nonce])

  // Once the pulsed turn is in the DOM, scroll it into view (reduced-motion →
  // instant) and clear the pulse after a short, self-terminating window so the
  // highlight reads as a brief flash, not a permanent selection. Depends on the
  // whole {index, nonce} pulse object: a repeat request for the SAME turn still
  // re-runs (fresh nonce), restarting the timer so the pulse lasts its full
  // window after the LATEST click.
  useEffect(() => {
    if (pulse === null) return
    pulseSegmentRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'center'
    })
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
    pulseTimerRef.current = setTimeout(() => setPulse(null), 1600)
    return () => {
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
    }
  }, [pulse, prefersReducedMotion])

  // A (re)start of playback re-enables following: undefined→defined means this
  // transcript's audio just started (e.g. MeetingDetail, where currentTimeMs is
  // undefined unless this recording is the one playing), and a jump back to the
  // very start means a stop→play restart (position resets toward 0).
  useEffect(() => {
    const prev = prevTimeMsRef.current
    prevTimeMsRef.current = currentTimeMs
    if (currentTimeMs === undefined) return
    const started =
      prev === undefined || (currentTimeMs < 1200 && prev - currentTimeMs > 400)
    if (started) setAutoFollow(true)
  }, [currentTimeMs])

  // Scroll the transcript to its very top (position 0). Used when "Follow" is
  // tapped while nothing is playing — there is no live position to center on, so
  // we return the reader to the start of the transcript instead of a stale turn.
  const scrollToTop = useCallback(() => {
    containerRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start'
    })
  }, [prefersReducedMotion])

  // Auto-scroll to current segment during playback, unless the user paused
  // following by scrolling manually. Reduced motion → instant (WCAG 2.3.3).
  useEffect(() => {
    if (!autoFollow) return
    // Nothing is playing → don't chase a stale currentTimeMs (which, when it
    // holds a value past this transcript, resolves to the LAST segment and would
    // yank the view to the end). The explicit "Follow" tap handles this case.
    if (isPlaying === false) return
    if (currentSegmentIndex >= 0 && activeSegmentRef.current) {
      activeSegmentRef.current.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'center'
      })
    }
  }, [currentSegmentIndex, autoFollow, prefersReducedMotion, isPlaying])

  // A manual scroll intent (wheel / touch drag) over the transcript pauses
  // auto-follow so we don't yank the view back while the user is reading. Only
  // meaningful once we have timestamps to follow.
  const pauseFollowOnManualScroll = useCallback(() => {
    if (hasTimestamps) setAutoFollow(false)
  }, [hasTimestamps])

  // Render structured turns when we have timestamps or detected speakers; else plain text
  const hasStructure = hasTimestamps || segments.some((seg) => seg.speaker)

  return (
    <div className="divide-y divide-border">
      {/* Summary Section */}
      {showSummary && summary && (
        <section className="py-3 first:pt-0">
          <button
            onClick={() => setSummaryExpanded(!summaryExpanded)}
            className="flex items-center justify-between w-full text-left hover:text-foreground/70 transition-colors"
            aria-expanded={summaryExpanded}
          >
            <span className="text-sm font-semibold">Summary</span>
            {summaryExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {summaryExpanded && (
            <p className="text-sm whitespace-pre-wrap leading-relaxed mt-2">{summary}</p>
          )}
        </section>
      )}

      {/* Action Items Section */}
      {showActionItems && actionItems && actionItems.length > 0 && (
        <section className="py-3 first:pt-0">
          <button
            onClick={() => setActionItemsExpanded(!actionItemsExpanded)}
            className="flex items-center justify-between w-full text-left hover:text-foreground/70 transition-colors"
            aria-expanded={actionItemsExpanded}
          >
            <span className="text-sm font-semibold">Action Items</span>
            {actionItemsExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {actionItemsExpanded && (
            <ul className="list-disc list-inside text-sm space-y-1 mt-2">
              {actionItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Full Transcript Section */}
      <section className="py-3 first:pt-0 last:pb-0">
        {showTranscriptHeader && <div className="flex items-center gap-2">
          <button
            onClick={() => setTranscriptExpanded(!transcriptExpanded)}
            className="flex items-center justify-between flex-1 text-left hover:text-foreground/70 transition-colors"
            aria-expanded={transcriptExpanded}
          >
            <span className="text-sm font-semibold">Full Transcript</span>
            {transcriptExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {/* Resume auto-follow after a manual scroll paused it (only relevant
              for timestamped transcripts that can follow playback). */}
          {hasTimestamps && !autoFollow && (
            <button
              onClick={() => {
                setAutoFollow(true)
                // Not playing: jump to the top of the transcript (position 0)
                // rather than the current (stale/last) segment.
                if (isPlaying === false) scrollToTop()
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
              title={isPlaying === false ? 'Jump to the top of the transcript' : 'Resume auto-scroll to follow playback'}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              Follow
            </button>
          )}
        </div>}
        {!showTranscriptHeader && hasTimestamps && !autoFollow && (
          <div className="flex justify-end">
            <button
              onClick={() => {
                setAutoFollow(true)
                if (isPlaying === false) scrollToTop()
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-accent"
              title={isPlaying === false ? 'Jump to the top of the transcript' : 'Resume auto-scroll to follow playback'}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              Follow
            </button>
          </div>
        )}
        {transcriptExpanded && (
          <div
            ref={containerRef}
            className="mt-2 pr-1"
            onWheel={pauseFollowOnManualScroll}
            onTouchMove={pauseFollowOnManualScroll}
          >
            {ragPending && (
              <div
                className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
                role="status"
              >
                <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  Transcript saved. RAG search is pending: {ragPending}
                </span>
                <button
                  type="button"
                  onClick={() => void retryRag()}
                  disabled={retryingRag}
                  aria-busy={retryingRag || undefined}
                  title={retryingRag ? 'Updating RAG' : undefined}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold text-amber-100 transition-colors hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:cursor-wait disabled:opacity-60"
                >
                  {/* Busy keeps the verb; the state goes to the tooltip (owner, 2-oct-2026). */}
                  {retryingRag
                    ? <BusyIcon className="h-3.5 w-3.5" />
                    : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                  Retry RAG
                </button>
              </div>
            )}
            {hasStructure || editEnabled ? (
              <div className="space-y-1">
                {segments.map((segment, i) => {
                  // Per-turn identity resolution (v37). base = raw diarization
                  // label; effective = base or its split-derived label; a per-turn
                  // override supersedes the label map for display + reset.
                  const base = segment.speaker
                  const effective = base ? effectiveLabelFor(base, i, splits) : undefined
                  const override = turnOverrides.get(i)
                  const labelAssign = effective ? speakerMap.get(effective) : undefined
                  const assignedContactId = override?.contactId ?? labelAssign?.contactId
                  const assignedName = override?.name ?? labelAssign?.name
                  const assignmentProvenance: 'turn' | 'label' | undefined = override
                    ? 'turn'
                    : labelAssign
                      ? 'label'
                      : undefined
                  const hasSplitHere = base ? splits.some((s) => s.baseLabel === base && s.fromIndex === i) : false
                  const canSplitHere = base
                    ? segments.slice(0, i).some((s) => s.speaker === base)
                    : false
                  const mergeSuspected = base ? mergeHints.has(base) : false
                  const lineProblems = issuesByLine[i] ?? []
                  return (
                  <div
                    key={i}
                    ref={(el) => {
                      if (hasTimestamps && i === currentSegmentIndex) activeSegmentRef.current = el
                      if (i === pulse?.index) pulseSegmentRef.current = el
                    }}
                    data-testid={i === pulse?.index ? 'transcript-turn-highlighted' : undefined}
                    data-line-issues={lineProblems.length > 0 ? lineProblems.join(' ') : undefined}
                    className={cn(
                      'group/turn text-sm p-2 rounded-md transition-colors',
                      // A line the integrity check flagged: amber edge, tags below.
                      lineProblems.length > 0 && 'border-l-2 border-amber-500/70 bg-amber-500/5 pl-2.5',
                      hasTimestamps && i === currentSegmentIndex && 'bg-primary/10',
                      // Brief cross-highlight pulse from a timeline marker click. The
                      // ring + wash fade out (motion-safe) when the pulse clears; a
                      // reduced-motion user just gets the instant appear/disappear.
                      i === pulse?.index &&
                        'bg-primary/20 ring-2 ring-primary/60 motion-safe:transition-[background-color,box-shadow] motion-safe:duration-700'
                    )}
                  >
                    {(hasTimestamps || segment.speaker) && (
                      <div className="flex items-center gap-2 mb-1">
                        {hasTimestamps && (
                          <TimeAnchor
                            startMs={segment.startMs}
                            endMs={segment.endMs}
                            isActive={i === currentSegmentIndex}
                            onSeek={onSeek}
                          >
                            {null}
                          </TimeAnchor>
                        )}
                        {segment.speaker && effective && (
                          assignEnabled ? (
                            <SpeakerAssignPopover
                              label={effective}
                              turnIndex={i}
                              assignedContactId={assignedContactId}
                              assignedName={assignedName}
                              assignmentScope={assignmentProvenance}
                              contacts={contacts}
                              onOpen={ensureContacts}
                              onAssign={(scope: AssignScope, payload) =>
                                assignSpeakerScoped(scope, { effectiveLabel: effective, baseLabel: base!, turnIndex: i }, payload)
                              }
                              onUnassign={() =>
                                unassignSpeakerScoped({ effectiveLabel: effective, turnIndex: i, hasOverride: Boolean(override) })
                              }
                              canSplitHere={canSplitHere}
                              hasSplitHere={hasSplitHere}
                              onSplit={() => splitSpeaker(base!, i)}
                              onMergeSplit={() => mergeSplit(base!, i)}
                              mergeSuspected={mergeSuspected}
                            />
                          ) : (
                            <span className="font-semibold text-foreground">
                              {segment.speaker}
                            </span>
                          )
                        )}
                        {lineProblems.map((code) => (
                          <span
                            key={code}
                            className="rounded-full border border-amber-500/50 px-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-400"
                          >
                            {ISSUE_TAGS[code]}
                          </span>
                        ))}
                      </div>
                    )}
                    {editingIndex === i ? (
                      <div className="space-y-2">
                        <textarea
                          autoFocus
                          value={editDraft}
                          onChange={(event) => {
                            setEditDraft(event.target.value)
                            if (editError) setEditError(null)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelEditing()
                            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                              event.preventDefault()
                              void saveCorrection()
                            }
                          }}
                          disabled={savingIndex === i}
                          rows={Math.min(8, Math.max(2, editDraft.split('\n').length + 1))}
                          aria-label={`Edit transcript turn ${i + 1}`}
                          aria-describedby={`transcript-edit-hint-${i}${editError ? ` transcript-edit-error-${i}` : ''}`}
                          className="w-full resize-y rounded-lg border border-primary/50 bg-background px-3 py-2 text-sm leading-relaxed text-foreground shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:cursor-wait disabled:opacity-70"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          {hasTimestamps && (
                            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              Starts at
                              <input
                                value={editStart}
                                onChange={(event) => {
                                  setEditStart(event.target.value)
                                  if (editError) setEditError(null)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    cancelEditing()
                                  } else if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void saveCorrection()
                                  }
                                }}
                                disabled={savingIndex === i}
                                inputMode="decimal"
                                aria-label={`Start time of transcript turn ${i + 1}`}
                                className="w-20 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
                              />
                            </label>
                          )}
                          <span id={`transcript-edit-hint-${i}`} className="mr-auto text-xs text-muted-foreground">
                            Ctrl+Enter saves and rebuilds RAG. Esc cancels.
                          </span>
                          <button
                            type="button"
                            onClick={cancelEditing}
                            disabled={savingIndex === i}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void saveCorrection()}
                            disabled={savingIndex === i || !editDraft.trim()}
                            aria-busy={savingIndex === i || undefined}
                            title={savingIndex === i ? 'Saving and rebuilding RAG' : undefined}
                            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50"
                          >
                            {savingIndex === i ? (
                              <BusyIcon className="h-3.5 w-3.5" />
                            ) : (
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            Save correction
                          </button>
                        </div>
                        {editError && (
                          <p id={`transcript-edit-error-${i}`} className="text-xs text-destructive" role="alert">
                            {editError}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="relative min-w-0">
                        <p className="whitespace-pre-wrap pr-9 leading-relaxed [overflow-wrap:anywhere]">{segment.text}</p>
                        {editEnabled && (
                          <button
                            type="button"
                            onClick={() => startEditing(i)}
                            disabled={savingIndex !== null}
                            className="absolute -top-1 right-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-20 group-hover/turn:opacity-100"
                            aria-label={`Edit transcript turn ${i + 1}`}
                            title="Edit this transcript turn"
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            ) : (
              <div className="space-y-2">
                {toParagraphs(transcript).map((para, i) => (
                  <p key={i} className="text-sm whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">
                    {para}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
