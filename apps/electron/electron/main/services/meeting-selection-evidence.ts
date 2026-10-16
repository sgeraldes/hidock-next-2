/** Auto-linking needs a transcript anchor to this event, not an LLM confidence score alone. */
export interface MeetingSelectionEvidence {
  kind: 'explicit-event-reference' | 'specific-agenda'
  transcript_quote: string
  calendar_quote: string
}

function normalized(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function contains(source: string, quote: string): boolean {
  return (` ${normalized(source)} `).includes(` ${normalized(quote)} `)
}

const GENERIC_AGENDA = new Set([
  'discuss', 'project', 'status', 'next', 'steps', 'review', 'meeting', 'team', 'update', 'progress',
  'revisar', 'discutir', 'proyecto', 'estado', 'proximos', 'pasos', 'reunion', 'equipo', 'avance',
  'join', 'microsoft', 'teams', 'click', 'here', 'unirse', 'hacer', 'clic', 'aqui'
])

function contradictsEventReference(transcript: string, evidenceQuote: string, reference: string): boolean {
  const text = normalized(transcript)
  const quote = normalized(evidenceQuote)
  const target = normalized(reference)
  const start = text.indexOf(quote) + quote.indexOf(target)
  const before = text.slice(Math.max(0, start - 70), start).trim()
  const after = text.slice(start + target.length, start + target.length + 100).trim()
  // Attach rejection/history to the event reference itself, rather than unrelated negative words nearby.
  return /\b(is not|isn t|not|previous|earlier|no es|no era|no estamos en|anterior)(?: the| la| el| esta)?$/.test(before)
    || /^(?:has |had |was |ya |se |ha |habia )?(?:ended|finished|termino|terminado|anterior|fue antes)\b/.test(after)
}

/** Missing agenda/roster is unknown; general company/client vocabulary cannot establish an event. */
export function hasVerifiedMeetingSelectionEvidence(
  transcript: string,
  meeting: { subject: string; description?: string | null },
  evidence: unknown
): boolean {
  if (!evidence || typeof evidence !== 'object') return false
  const anchor = evidence as Partial<MeetingSelectionEvidence>
  if (typeof anchor.transcript_quote !== 'string' || typeof anchor.calendar_quote !== 'string') return false
  if (!anchor.transcript_quote.trim() || !anchor.calendar_quote.trim()) return false
  if (!contains(transcript, anchor.transcript_quote)) return false
  if (anchor.kind === 'explicit-event-reference') {
    // The actual event name must be spoken, rather than introduced by the model in its explanation.
    return normalized(anchor.calendar_quote) === normalized(meeting.subject)
      && contains(anchor.transcript_quote, meeting.subject)
      && !contradictsEventReference(transcript, anchor.transcript_quote, meeting.subject)
  }
  if (anchor.kind !== 'specific-agenda' || !meeting.description) return false
  if (!contains(meeting.description, anchor.calendar_quote)) return false
  // A concrete agenda phrase, quoted in both sources, rather than one shared client or company name.
  const words = normalized(anchor.calendar_quote).split(' ')
  return words.length >= 5
    && new Set(words.filter((word) => word.length >= 4 && !GENERIC_AGENDA.has(word))).size >= 3
    && contains(anchor.transcript_quote, anchor.calendar_quote)
    && !contradictsEventReference(transcript, anchor.transcript_quote, anchor.calendar_quote)
}

export const MEETING_SELECTION_RULES = `
Meeting candidates are hypotheses, not facts. "none" is a valid and preferred answer when evidence is weak.
Sharing an employer, client, project, broad technical topics, or time overlap is NOT evidence of the same event.
A later ad-hoc call may overlap a scheduled meeting without belonging to it. Do not infer recording parts.
Missing invitees are unknown, not confirmation. A person mentioned is not necessarily a participant.
To select an event, provide selection_evidence: an exact transcript_quote and calendar_quote, with kind
"explicit-event-reference" (the actual event subject is spoken) or "specific-agenda" (a concrete agenda
phrase of at least five words appears in both the transcript and the calendar description).
Do not invent quotes or turn the candidate subject supplied as context into evidence from the audio.
If no such anchor exists, return selected_meeting_id="none", meeting_confidence=0, selection_evidence=null.
`
