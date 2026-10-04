/**
 * Pure name-normalization + fuzzy-scoring helpers for entity resolution (Round 4a).
 *
 * Kept dependency-free (no DB, no electron) so both database.ts and
 * entity-resolver.ts can share them without a circular import, and so the
 * scoring rules can be unit-tested in isolation.
 */

/**
 * Canonical name key: Unicode-normalize (NFKC), lowercase, trim, collapse
 * internal whitespace. Matches the graph store's key.
 *
 * NFKC matters for identity: composed vs decomposed accents ("café" typed as
 * NFC vs NFD) are DIFFERENT JS strings but the same name — without folding
 * them, a discovery-rejection tombstone written under one form fails to match
 * a re-analysis arriving in the other, and createProject can clear a different
 * key than the reconciler checks. NFKC also folds compatibility forms
 * (ligatures like ﬁ → fi, fullwidth chars, NBSP → space) so visually-identical
 * spellings share one key.
 */
export function normalizeName(name: string): string {
  return (name || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')
}

/** Combining-marks range U+0300–U+036F, built without literal marks in source. */
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g')

/** Strip diacritics/combining marks (NFD decompose + drop U+0300–U+036F). */
export function stripDiacritics(value: string): string {
  return (value || '').normalize('NFD').replace(COMBINING_MARKS, '')
}

/**
 * The keys already computed, by input. The key is a pure function of the string, and
 * the ambiguous-bucket pass asks for the key of every contact name once per contact
 * (about 2.6 million calls for 1,600 contacts): NFKC and NFD normalisation of the same
 * few thousand names made org-reconcile hold the main thread for 3 s at boot
 * (30-sep-2026). Bounded, and dropped whole when it fills.
 */
const ACCENT_FOLDED_KEYS = new Map<string, string>()
const ACCENT_FOLDED_KEYS_MAX = 50_000

/** Accent-insensitive normalized key: normalizeName + stripDiacritics. */
export function accentFoldedKey(name: string): string {
  const cached = ACCENT_FOLDED_KEYS.get(name)
  if (cached !== undefined) return cached
  const key = stripDiacritics(normalizeName(name))
  if (ACCENT_FOLDED_KEYS.size >= ACCENT_FOLDED_KEYS_MAX) ACCENT_FOLDED_KEYS.clear()
  ACCENT_FOLDED_KEYS.set(name, key)
  return key
}

/** Whether a raw string looks like an email address (used to gate the email tier). */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim())
}

/** The start of a URL: a scheme ("https://") or "www.". */
const URL_START = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i
/** A bare domain ("rappi.com"); its top-level domain is checked separately. */
const BARE_DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,})(?:\/\S*)?$/i
/** Generic top-level domains common enough to tell "Rappi.com" from "J.Perez". */
const GENERIC_TLDS = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'io', 'co', 'ai', 'app', 'dev', 'me', 'tv',
  'xyz', 'online', 'site', 'tech', 'cloud', 'store', 'shop'
])
/** A one-word name: letters and marks, joined by a hyphen or apostrophe (Se-young, O'Neil). */
const NAME_WORD = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u
const ANY_LETTER = /\p{L}/u
const STARTS_UPPERCASE = /^\p{Lu}/u

/** A URL, or a bare domain with a real top-level domain (a generic one, or a two-letter country one in lowercase). */
function isUrlShaped(text: string): boolean {
  if (URL_START.test(text)) return true
  const domain = BARE_DOMAIN.exec(text)
  if (!domain) return false
  const tld = domain[1]
  return GENERIC_TLDS.has(tld.toLowerCase()) || /^[a-z]{2}$/.test(tld)
}

/**
 * Whether a string cannot be a person's name: anything with an "@" (an address, or
 * "Name <address>"), a URL or a bare domain, a string with no letters (a phone number,
 * digits), or a single word with characters a name never has, which is how the start
 * of an address looks ("edgar.anzola", "juanchobq2017", "julik_100"). A dotted word
 * with a capital at the start of each part is a name ("J.Perez", "José.García").
 * Such a string is never a shared-first-name bucket, never matches a first name, and
 * is never stored as a contact's name when the calendar gives one. 3-oct-2026: contacts
 * named after their address were buckets, because "juanchobq2017@gmail.com" starts with Juan.
 */
export function isNotAPersonName(value: string): boolean {
  const text = (value || '').trim()
  if (!text || text.includes('@')) return true
  if (isUrlShaped(text)) return true
  if (!ANY_LETTER.test(text)) return true
  if (/\s/.test(text) || NAME_WORD.test(text)) return false
  const parts = text.split('.')
  return !(parts.length > 1 && parts.every((part) => NAME_WORD.test(part) && STARTS_UPPERCASE.test(part)))
}

/**
 * Local parts of role and shared mailboxes: one address, several people (review of PR 4, F1).
 * A local part matches when it is one of these, or starts with one followed by a separator
 * ("support-latam", "info.es").
 */
const SHARED_MAILBOX_LOCAL_PARTS = [
  'info', 'support', 'sales', 'admin', 'administracion', 'team', 'equipo', 'contact', 'contacto', 'hello', 'hola',
  'office', 'oficina', 'billing', 'facturacion', 'accounts', 'accounting', 'finance', 'finanzas', 'hr', 'rrhh',
  'jobs', 'careers', 'empleos', 'talento', 'marketing', 'help', 'helpdesk', 'service', 'services', 'servicio',
  'servicios', 'soporte', 'ventas', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications',
  'notificaciones', 'calendar', 'booking', 'bookings', 'reservas', 'recepcion', 'reception', 'it', 'ops',
  'operations', 'legal', 'press', 'prensa', 'media', 'security', 'compras', 'purchasing', 'mail', 'all', 'everyone',
  'todos', 'staff', 'group', 'grupo', 'list', 'lista'
]

/** True when an address belongs to a role or shared mailbox, or is a plus address. */
export function isSharedMailbox(email: string): boolean {
  const local = email.trim().toLowerCase().split('@')[0] ?? ''
  if (!local || local.includes('+')) return true
  return SHARED_MAILBOX_LOCAL_PARTS.some((word) => local === word || new RegExp(`^${word}[._-]`).test(local))
}

/**
 * The addresses one meeting lists under two different display names, as a distribution
 * list does (lowercased). Names compare accent-folded; the address itself and its start
 * do not count as names.
 */
export function addressesUnderTwoNames(
  people: ReadonlyArray<{ name?: string | null; email?: string | null }>
): Set<string> {
  const namesByAddress = new Map<string, Set<string>>()
  for (const person of people) {
    const address = (person.email || '').trim().toLowerCase()
    if (!address) continue
    const name = person.name ? accentFoldedKey(person.name) : ''
    if (!name || name === address || name === address.split('@')[0]) continue
    let names = namesByAddress.get(address)
    if (!names) namesByAddress.set(address, (names = new Set()))
    names.add(name)
  }
  return new Set([...namesByAddress].filter(([, names]) => names.size > 1).map(([address]) => address))
}

/** The part of an address before the "@", lowercased: the placeholder name of a contact the calendar gave no name for. */
export function addressLocalPart(email: string | null | undefined): string {
  return (email || '').trim().toLowerCase().split('@')[0] ?? ''
}

/**
 * The person's name as a calendar gives it for an address, or null when it gives none:
 * no name, a string that is not a name (often the address itself), or the start of the
 * address exactly as the placeholder writes it ("csiccha" for csiccha@antamina.com).
 * "Carmen" for carmen@acme.com is a real name (review of PR 143, F1).
 */
export function calendarDisplayName(name: string | null | undefined, email: string | null | undefined): string | null {
  const text = (name || '').trim()
  if (!text || isNotAPersonName(text)) return null
  const local = addressLocalPart(email)
  if (local && text === local) return null
  return text
}

/** A generic transcript speaker label ("Speaker", "Speaker 2") carries no identity. */
export function isGenericSpeakerLabel(value: string): boolean {
  return /^speaker\s*\d*$/i.test((value || '').trim())
}

/**
 * Words that mark a role parenthetical as an extraction artifact ("Engineer
 * (mencionado)") rather than a meaningful qualifier ("VP (Sales)"). EN + ES. Kept in
 * sync with the renderer helper in src/lib/roleHygiene.ts.
 */
const ROLE_ARTIFACT_PARENS = new RegExp(
  '\\s*\\((?:[^)]*\\b(?:mencionad[oa]s?|mentioned|inferred|inferid[oa]s?|assumed|asumid[oa]s?|' +
    'posible|possible|probable|likely|guess(?:ed)?|unverified|unconfirmed|no confirmad[oa]|' +
    'sin confirmar|unknown|desconocid[oa]|implied|implicad[oa])\\b[^)]*)\\)',
  'gi'
)

/** Strip extraction-artifact parentheticals from a role before storing it. Idempotent. */
export function cleanRole(role: string | null | undefined): string {
  if (!role) return ''
  return role
    .replace(ROLE_ARTIFACT_PARENS, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—,·|/]\s*$/, '')
    .trim()
}

/** Classic Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/** Whether either normalized string is a whole-word member of the other. */
function sharesWord(a: string, b: string): boolean {
  const aw = a.split(' ').filter((w) => w.length >= 3)
  const bw = b.split(' ').filter((w) => w.length >= 3)
  return aw.some((w) => bw.includes(w))
}

/** How much an opposite-gender Spanish name pair is docked from its fuzzy score. */
const GENDER_PAIR_PENALTY = 0.25

/**
 * Shortest name for which a 1- or 2-character edit distance still reads as a
 * misspelling rather than a different word. Below these, distance is noise:
 * every 2-char string is within distance 2 of every other.
 */
const MIN_LEN_FOR_EDIT_1 = 4
const MIN_LEN_FOR_EDIT_2 = 5

/**
 * For a SHORT name, a prefix match must be a genuine expansion rather than a
 * one-or-two-character variant. Without this the prefix rule quietly undoes the
 * length-gated edit-distance rule above: "crm" vs "crmx" is rejected as an edit
 * (distance 1 on 3 chars) but still scored 0.68 as a prefix, and the resolver's
 * co-occurrence boost (+0.15) carried it to 0.83 — over the 0.8 auto-link line —
 * silently attaching one short acronym project to a different one in the same
 * meeting. Nickname expansions are unaffected: "edu"/"eduardo" grows by 4.
 */
const MIN_PREFIX_GROWTH = 2

/** True when two ≥3-char tokens are identical but for a final a↔o (Sergio/Sergia). */
function isGenderVowelSwap(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 3) return false
  const al = a[a.length - 1]
  const bl = b[b.length - 1]
  const swapped = (al === 'a' && bl === 'o') || (al === 'o' && bl === 'a')
  return swapped && a.slice(0, -1) === b.slice(0, -1)
}

/**
 * Two normalized names that differ in exactly one token, where that token is an
 * opposite-gender Spanish pair (Fernando/Fernanda, Sergio/Sergia, and the same
 * swap inside an otherwise-identical full name). These read as a near-miss to a
 * pure edit-distance check but are almost always *different people*, so callers
 * dock the fuzzy score to keep them out of the auto-suggest band.
 */
export function isOppositeGenderSpanishPair(aNorm: string, bNorm: string): boolean {
  if (!aNorm || !bNorm) return false
  const at = aNorm.split(' ')
  const bt = bNorm.split(' ')
  if (at.length !== bt.length) return false
  let diffs = 0
  let gendered = false
  for (let i = 0; i < at.length; i++) {
    if (at[i] === bt[i]) continue
    if (++diffs > 1) return false
    gendered = isGenderVowelSwap(at[i], bt[i])
  }
  return diffs === 1 && gendered
}

/**
 * Fuzzy similarity of two already-normalized names, returning a base confidence
 * in the 0.6–0.8 band (0 = not a fuzzy match). Rules (INTELLIGENCE.md §2):
 * Levenshtein ≤2, or a prefix/contained-word overlap on the normalized names.
 * The caller adds a context boost and applies the tier thresholds.
 *
 * Opposite-gender Spanish pairs (Fernando/Fernanda) match by edit distance but
 * are docked {@link GENDER_PAIR_PENALTY} so they fall below the suggestion bar
 * unless another signal (email/graph) independently corroborates the pairing.
 */
export function fuzzyNameScore(aNorm: string, bNorm: string): number {
  if (!aNorm || !bNorm) return 0

  let score: number
  if (aNorm === bNorm) {
    score = 0.8
  } else {
    const dist = levenshtein(aNorm, bNorm)
    const minLen = Math.min(aNorm.length, bNorm.length)
    // An edit distance only signals a typo RELATIVE to length. Flat thresholds
    // made every short name a near-miss for every other: "AI" vs "XR" is
    // distance 2 on a 2-char string — i.e. entirely different — yet scored 0.7
    // and, with a context boost, auto-linked one acronym project onto another.
    // Require the shorter name to be long enough for the distance to mean
    // "misspelling" rather than "different word".
    if (dist === 1 && minLen >= MIN_LEN_FOR_EDIT_1) score = 0.78
    else if (dist === 2 && minLen >= MIN_LEN_FOR_EDIT_2) score = 0.7
    else if (
      minLen >= 3 &&
      (aNorm.startsWith(bNorm) || bNorm.startsWith(aNorm)) &&
      // Short names must GROW meaningfully to count as a prefix expansion.
      (minLen >= MIN_LEN_FOR_EDIT_2 || Math.max(aNorm.length, bNorm.length) - minLen >= MIN_PREFIX_GROWTH)
    )
      score = 0.68
    else if (sharesWord(aNorm, bNorm)) score = 0.62
    else return 0
  }

  if (isOppositeGenderSpanishPair(aNorm, bNorm)) {
    score = Math.max(0, score - GENDER_PAIR_PENALTY)
  }
  return score
}

// ---------------------------------------------------------------------------
// Ambiguous-name ("mention bucket") detection
// ---------------------------------------------------------------------------
//
// A bare first name or nickname ("Sergio", "Sergi", "Santi") is NOT a person — it
// is an unresolved MENTION BUCKET when the corpus holds several distinct
// surname-bearing people it could denote (Sergio Hurtado, Sergio Reyes). Merging
// those real people into the bucket, or the bucket into one of them, is wrong for
// roughly half the mentions. These pure helpers let the resolver, the discovery
// sweep, and the DB layer agree on what counts as an ambiguous bucket.

/** The tokens already split, by input. Frozen because every caller shares the array. */
const NAME_TOKENS = new Map<string, readonly string[]>()

/** Accent-folded whitespace tokens of a name (lowercased, marks stripped, ≥1 char). */
export function nameTokens(name: string): readonly string[] {
  const cached = NAME_TOKENS.get(name)
  if (cached !== undefined) return cached
  const tokens = Object.freeze(accentFoldedKey(name).split(' ').filter(Boolean))
  if (NAME_TOKENS.size >= ACCENT_FOLDED_KEYS_MAX) NAME_TOKENS.clear()
  NAME_TOKENS.set(name, tokens)
  return tokens
}

/** A name is a single token when it has exactly one whitespace-delimited word. */
export function isSingleToken(name: string): boolean {
  return nameTokens(name).length === 1
}

/** A name "bears a surname" when it carries ≥2 tokens (a first name plus more). */
export function hasSurname(name: string): boolean {
  return nameTokens(name).length >= 2
}

/**
 * Whether a bare first-name/nickname token identifies the first name of a full name.
 * Accent-folded; matches when the full name's first token equals the bucket token, or
 * one is a prefix of the other — a Spanish nickname is a prefix of the full first
 * name (Sergi→Sergio, Santi→Santiago, Sebas→Sebastián). Requires ≥3 chars on each so
 * a two-letter fragment never collides half the directory. A string that is not a
 * name ({@link isNotAPersonName}) on either side never matches: "juanchobq2017@gmail.com"
 * starts with "juan" but is not Juan.
 */
export function firstNameNicknameMatch(bucketToken: string, fullName: string): boolean {
  const b = accentFoldedKey(bucketToken)
  const first = nameTokens(fullName)[0] || ''
  if (b.length < 3 || first.length < 3) return false
  if (!(b === first || first.startsWith(b) || b.startsWith(first))) return false
  // Checked last: the bucket pass calls this once per pair of contacts.
  return !isNotAPersonName(bucketToken) && !isNotAPersonName(fullName)
}

export interface AmbiguityMatch {
  id: string
  name: string
}

export interface AmbiguityResult {
  /** True when the name is a single-token/nickname matching ≥2 distinct surname bearers. */
  ambiguous: boolean
  /** Accent-folded bucket token (empty when the name is not a single token). */
  token: string
  /** The distinct surname-bearing contacts the bucket first name fits, by id. */
  matches: AmbiguityMatch[]
}

/** Minimum token length for a bucket to be considered (guards against "Al"/"Jo"). */
const MIN_BUCKET_TOKEN = 3

/**
 * Classify a name against a contact corpus as an ambiguous mention bucket. Pure:
 * it takes the candidate list so it can be unit-tested and shared by the resolver,
 * discovery, and the DB layer without a cycle. A name is an ambiguous bucket when
 * it is a single token (or nickname prefix) that {@link firstNameNicknameMatch}es
 * ≥2 DISTINCT surname-bearing contacts. Distinctness is by accent-folded full name
 * (so duplicate rows of one person do not manufacture ambiguity); `selfId` excludes
 * the bucket's own row. A name that is not a person's name (an address, a URL, a phone
 * number: {@link isNotAPersonName}) is never a bucket, and a contact with such a name is
 * never one of a bucket's candidates.
 */
export function detectAmbiguousName(
  name: string,
  contacts: Array<{ id: string; name: string }>,
  selfId?: string
): AmbiguityResult {
  if (!isSingleToken(name) || isNotAPersonName(name)) return { ambiguous: false, token: '', matches: [] }
  const token = nameTokens(name)[0] || ''
  if (token.length < MIN_BUCKET_TOKEN) return { ambiguous: false, token, matches: [] }

  const matches: AmbiguityMatch[] = []
  const seenNames = new Set<string>()
  for (const c of contacts) {
    if (selfId && c.id === selfId) continue
    if (!hasSurname(c.name)) continue
    if (!firstNameNicknameMatch(token, c.name)) continue
    const key = accentFoldedKey(c.name)
    if (seenNames.has(key)) continue
    seenNames.add(key)
    matches.push({ id: c.id, name: c.name })
  }
  return { ambiguous: matches.length >= 2, token, matches }
}
