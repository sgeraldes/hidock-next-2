/**
 * Minimal client for Jev, TypeSafe AI's System One decision model.
 *
 * API reference (read 27-sep-2026): https://docs.typesafe.ai/api
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>
 *   { state, model: "jev-latest", questions: { <id>: Question } }
 *   -> { model, answers: { <id>: Answer }, usage: { input_tokens, output_tokens } }
 *
 * Question types: noul (yes/no -> probability of yes), choice (one of named
 * options -> choice + probabilities + confidence), score (ordered levels ->
 * weighted score + probabilities + confidence). All questions in one call are
 * answered in parallel against the same state.
 *
 * No retries here: callers already own a retry policy (the value backfill
 * retries each item 1 s / 2 s / 4 s). A failed call throws JevError with the
 * HTTP status so a caller can tell a bad key (401) from a transient 429/529.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'
const DEFAULT_TIMEOUT_MS = 30_000

export type JevStructured = string | Record<string, unknown> | unknown[]

export type JevQuestion =
  | { type: 'noul'; instructions: JevStructured; criteria?: { true?: JevStructured; false?: JevStructured } }
  | { type: 'choice'; instructions: JevStructured; criteria: Record<string, JevStructured | null> }
  | { type: 'score'; instructions: JevStructured; criteria: JevStructured[] }

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score'
      score: number
      legend: Record<string, string>
      probabilities: Record<string, number>
      confidence: number
    }

export interface JevResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
    this.name = 'JevError'
  }
}

export interface AskJevOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function askJev(
  apiKey: string,
  state: JevStructured,
  questions: Record<string, JevQuestion>,
  opts: AskJevOptions = {}
): Promise<JevResponse> {
  if (!apiKey.trim()) throw new JevError('Jev API key is empty', null)
  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
      signal: controller.signal
    })
  } catch (e) {
    const reason = controller.signal.aborted ? 'timed out' : e instanceof Error ? e.message : String(e)
    throw new JevError(`Jev request failed: ${reason}`, null)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // The error body describes the offending field (422) or the auth problem
    // (401). It never echoes the key; keep it short for the log.
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new JevError(`Jev returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status)
  }

  const body = (await res.json()) as Partial<JevResponse>
  if (!body || typeof body.answers !== 'object' || body.answers === null) {
    throw new JevError('Jev response has no answers', res.status)
  }
  return {
    model: String(body.model ?? ''),
    answers: body.answers as Record<string, JevAnswer>,
    usage: body.usage ?? { input_tokens: 0, output_tokens: 0 }
  }
}
