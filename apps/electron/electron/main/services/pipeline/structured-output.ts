/**
 * Structured output as a contract, not a prompt habit (pipeline design, section 6, rule 2).
 *
 * A task defines a contract: a name, a zod schema and an example. The runner asks a harness in its
 * native structured mode where it has one; otherwise it appends `schemaInstruction(contract)` to the
 * prompt. Either way the answer comes back here: the JSON is found in whatever surrounds it, repaired
 * by `repairJsonString` if it does not parse, and checked against the schema. If that fails, ONE repair
 * call (a cheap profile asked to fix the JSON) is allowed, and then the step fails with a reason.
 *
 * A failure never carries content: it names the reason, the length of the raw answer and the fields
 * that failed, so it can go in a log and in a processing run. The answer may be a private transcript.
 */
import { z } from 'zod'
import { repairJsonString } from './json-repair'

export interface Contract<T> {
  name: string
  schema: z.ZodType<T>
  /** JSON shown to a model that has no native structured mode. */
  example: string
}

export function defineContract<T>(name: string, schema: z.ZodType<T>, example: unknown): Contract<T> {
  return { name, schema, example: JSON.stringify(example, null, 2) }
}

/** The sentence-and-example a prompt carries when the harness cannot enforce a schema itself. */
export function schemaInstruction(contract: Contract<unknown>): string {
  return `Reply with only JSON, no other text, in exactly this shape (the values are examples):\n${contract.example}`
}

export type ContractFailureReason = 'empty' | 'no-json' | 'invalid-json' | 'schema-mismatch'

export class ContractError extends Error {
  constructor(
    readonly reason: ContractFailureReason,
    readonly rawLength: number,
    readonly issuePaths: string[] = []
  ) {
    super(
      `structured output failed: ${reason}` +
        (issuePaths.length > 0 ? ` (${issuePaths.join(', ')})` : '') +
        ` [${rawLength} characters]`
    )
    this.name = 'ContractError'
  }
}

/**
 * The JSON of a model answer: what follows the first `{` or `[`, code fences removed. Trailing prose
 * stays on the end; the repair pass drops anything after the root value closes. Null when there is none.
 */
export function extractJsonText(raw: string): string | null {
  const unfenced = raw.replace(/```(?:json|JSON)?/g, '')
  const start = unfenced.search(/[{[]/)
  if (start < 0) return null
  return unfenced.slice(start).trim()
}

export type ParseResult<T> = { ok: true; value: T; repaired: boolean } | { ok: false; error: ContractError }

export function parseWithContract<T>(contract: Contract<T>, raw: string): ParseResult<T> {
  if (!raw.trim()) return { ok: false, error: new ContractError('empty', raw.length) }
  const text = extractJsonText(raw)
  if (text === null) return { ok: false, error: new ContractError('no-json', raw.length) }

  let value: unknown
  let repaired = false
  try {
    value = JSON.parse(text)
  } catch {
    try {
      value = JSON.parse(repairJsonString(text))
      repaired = true
    } catch {
      return { ok: false, error: new ContractError('invalid-json', raw.length) }
    }
  }

  const checked = contract.schema.safeParse(value)
  if (!checked.success) {
    // Paths only: an issue message can echo a value from the answer.
    const paths = [...new Set(checked.error.issues.map((i) => i.path.join('.') || '(root)'))]
    return { ok: false, error: new ContractError('schema-mismatch', raw.length, paths) }
  }
  return { ok: true, value: checked.data, repaired }
}

export type ContractRun<T> =
  | { ok: true; value: T; repairedBy: 'parser' | 'call' | null }
  | { ok: false; error: ContractError }

/**
 * Call a harness, read its answer against the contract, and repair at most once.
 * `repair` receives the raw answer and the reason; it returns a new raw answer, or null.
 */
export async function runContract<T>(args: {
  contract: Contract<T>
  call: () => Promise<string | null>
  repair?: (raw: string, error: ContractError) => Promise<string | null>
}): Promise<ContractRun<T>> {
  const raw = await args.call()
  if (raw === null || !raw.trim()) return { ok: false, error: new ContractError('empty', raw?.length ?? 0) }

  const first = parseWithContract(args.contract, raw)
  if (first.ok) return { ok: true, value: first.value, repairedBy: first.repaired ? 'parser' : null }
  if (!args.repair) return first

  const fixed = await args.repair(raw, first.error)
  if (fixed === null || !fixed.trim()) return first
  const second = parseWithContract(args.contract, fixed)
  return second.ok ? { ok: true, value: second.value, repairedBy: 'call' } : second
}
