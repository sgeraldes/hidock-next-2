/**
 * One sentence per automatic identity decision (spec 2026-10-03, Phase 4): what was decided,
 * then the reason in words. "Speaker 2 in 'Weekly sync' (12 Sep) is Ana Ruiz: Ana Ruiz was the
 * only other person in this one-on-one". Methods are the rule names of signal-tiers.ts and
 * docs/identity-rules.md; an unknown one reads "decided by the app".
 */
import type { DecisionView } from '@/shared/identity-review'

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "12 Sep": the day and the short month, in local time. A fixed list: ICU writes "Sept" in some locales. */
export function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

interface Who {
  name: string
  possessive: string
  /** The person as the subject of the reason ("Ana Ruiz", or "they" for someone gone). */
  subject: string
  was: 'was' | 'were'
}

function who(personName: string | null): Who {
  if (!personName) return { name: 'a person no longer in People', possessive: 'their', subject: 'they', was: 'were' }
  return { name: personName, possessive: `${personName}'s`, subject: personName, was: 'was' }
}

/** " in 'Weekly sync' (12 Sep)": the meeting, else the recording, and the recording's date. */
function place(d: DecisionView): string {
  const title = d.meetingSubject || d.recordingTitle
  const where = title ? ` in '${title}'` : ''
  const when = d.recordingDate ? ` (${shortDate(d.recordingDate)})` : ''
  return `${where}${when}`
}

function head(d: DecisionView, person: Who): string {
  switch (d.kind) {
    case 'speaker':
      return `${d.subjectName || 'A speaker'}${place(d)} is ${person.name}`
    case 'mention':
      return `'${d.subjectName || 'A first name'}'${place(d)} is ${person.name}`
    case 'merge':
      return `Merged '${d.subjectName || 'a duplicate'}' into ${person.name}`
    case 'voice-anchor': {
      const total = (d.votes?.oneOnOne ?? 0) + (d.votes?.elimination ?? 0)
      return total > 0
        ? `A voice heard in ${numberWord(total)} recording${total === 1 ? '' : 's'} is ${person.name}`
        : `A voice is ${person.name}`
    }
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `a ${one}` : `${numberWord(n)} ${many}`
}

function oneOnOneReason(d: DecisionView, person: Who): string {
  const votes = d.votes
  if (d.kind !== 'voice-anchor' || !votes) return `${person.subject} ${person.was} the only other person in this one-on-one`
  const first = `${person.subject} ${person.was} the only other person in ${plural(votes.oneOnOne, 'one-on-one', 'one-on-ones')}`
  if (votes.elimination === 0) return first
  const other = votes.elimination === 1 ? 'one other meeting' : `${numberWord(votes.elimination)} other meetings`
  return `${first} and the only attendee left without a known voice in ${other}`
}

function eliminationReason(d: DecisionView, person: Who): string {
  const reason = `${person.subject} ${person.was} the only attendee left without a known voice`
  const n = d.kind === 'voice-anchor' ? d.votes?.elimination ?? 0 : 0
  return n > 0 ? `${reason} in ${n === 1 ? 'one meeting' : `${numberWord(n)} meetings`}` : reason
}

function sure(probability: number | null): string {
  return typeof probability === 'number' ? ` (${Math.round(probability * 100)}% sure)` : ''
}

function reason(d: DecisionView, person: Who): string {
  switch (d.method) {
    case 'voice':
      return d.kind === 'merge' ? 'same voice' : `the voice matches ${person.possessive} known voice`
    case 'exact-email':
    case 'email':
    case 'connector-email':
      return 'same email'
    case 'one-on-one':
      return oneOnOneReason(d, person)
    case 'elimination':
      return eliminationReason(d, person)
    case 'voice-presence':
      return `${person.possessive} voice is the only candidate's voice in the recording`
    case 'owner-presence':
      return `you speak in the recording and no other ${d.subjectName || 'candidate'} was there`
    case 'attendee-email':
      return `${person.subject} ${person.was} invited to the meeting`
    case 'attendee-context':
      return `${person.subject} ${person.was} the only ${d.subjectName || 'candidate'} in the meeting`
    case 'speaker-map':
      return 'the transcript names this speaker'
    case 'self-identification':
      return 'the speaker says their own name'
    case 'live-channel':
      return 'the voice came through your microphone in a Live recording'
    case 'jev-tiebreak':
      return d.kind === 'merge'
        ? `Jev judged them the same person${sure(d.probability)}`
        : `Jev chose ${person.name} among the people who were there${sure(d.probability)}`
    default:
      return 'decided by the app'
  }
}

export function decisionSentence(d: DecisionView): string {
  const person = who(d.personName)
  return `${head(d, person)}: ${reason(d, person)}`
}
