/**
 * The structured-output contract: extract JSON from a model answer, repair what can be repaired, check
 * the shape, ask for one repair call at most, and fail with a reason that carries no content.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  ContractError,
  defineContract,
  extractJsonText,
  parseWithContract,
  runContract,
  schemaInstruction
} from '../structured-output'
import { repairJsonString } from '../json-repair'

const summary = defineContract(
  'summary',
  z.object({ summary: z.string().min(1), topics: z.array(z.string()) }),
  { summary: 'Two sentences.', topics: ['budget'] }
)

describe('repairJsonString (moved)', () => {
  it('still escapes inner quotes and drops a trailing comma', () => {
    expect(JSON.parse(repairJsonString('{"a": "dijo "no" y", "b": [1,],}'))).toEqual({ a: 'dijo "no" y', b: [1] })
  })
})

describe('extractJsonText', () => {
  it('finds the JSON in a code fence and in prose', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJsonText('Here you go:\n{"a":1}\nHope it helps')).toBe('{"a":1}\nHope it helps')
    expect(extractJsonText('[1,2]')).toBe('[1,2]')
  })

  it('gives null when there is no JSON', () => {
    expect(extractJsonText('I cannot do that.')).toBeNull()
    expect(extractJsonText('   ')).toBeNull()
  })
})

describe('parseWithContract', () => {
  it('accepts a valid answer', () => {
    const r = parseWithContract(summary, '{"summary":"ok","topics":["a"]}')
    expect(r).toEqual({ ok: true, value: { summary: 'ok', topics: ['a'] }, repaired: false })
  })

  it('accepts an answer in a fence with prose around it', () => {
    const r = parseWithContract(summary, 'Sure!\n```json\n{"summary":"ok","topics":[]}\n```\nAnything else?')
    expect(r.ok).toBe(true)
  })

  it('repairs unescaped inner quotes, a wrong closer and trailing text, and says it did', () => {
    const r = parseWithContract(summary, '{"summary":"dijo "no" y se fue","topics":["a"]] trailing words')
    expect(r).toEqual({ ok: true, value: { summary: 'dijo "no" y se fue', topics: ['a'] }, repaired: true })
  })

  it('fails with no-json for prose, and empty for nothing', () => {
    const prose = parseWithContract(summary, 'I cannot help with that.')
    expect(prose.ok).toBe(false)
    if (!prose.ok) expect(prose.error.reason).toBe('no-json')
    const nothing = parseWithContract(summary, '  ')
    if (!nothing.ok) expect(nothing.error.reason).toBe('empty')
  })

  it('fails with schema-mismatch when the shape is wrong, naming the fields and never the content', () => {
    const r = parseWithContract(summary, '{"summary":"","topics":"budget","secret":"PRIVATE-TEXT"}')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.reason).toBe('schema-mismatch')
    expect(r.error.issuePaths.sort()).toEqual(['summary', 'topics'])
    expect(r.error.message).not.toContain('PRIVATE-TEXT')
    expect(r.error.rawLength).toBeGreaterThan(0)
  })

  it('never returns a half-filled object for a truncated answer: the closers are added, the shape check refuses it', () => {
    const r = parseWithContract(summary, '{"summary":"ok"')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(ContractError)
    expect(r.error.reason).toBe('schema-mismatch')
    expect(r.error.issuePaths).toEqual(['topics'])
  })
})

describe('schemaInstruction', () => {
  it('shows the model the shape by example and asks for JSON only', () => {
    const text = schemaInstruction(summary)
    expect(text).toContain('only JSON')
    expect(text).toContain('"summary": "Two sentences."')
  })
})

describe('runContract', () => {
  it('returns a valid first answer without asking for a repair', async () => {
    const repair = vi.fn()
    const r = await runContract({ contract: summary, call: async () => '{"summary":"ok","topics":[]}', repair })
    expect(r).toEqual({ ok: true, value: { summary: 'ok', topics: [] }, repairedBy: null })
    expect(repair).not.toHaveBeenCalled()
  })

  it('says the parser repaired it when the parser did', async () => {
    const r = await runContract({ contract: summary, call: async () => '{"summary":"a "b" c","topics":[],}' })
    expect(r).toMatchObject({ ok: true, repairedBy: 'parser' })
  })

  it('asks for one repair when the answer is unusable, and uses it', async () => {
    const repair = vi.fn(async (_raw: string, _error: ContractError) => '{"summary":"fixed","topics":["x"]}')
    const r = await runContract({ contract: summary, call: async () => 'no json here', repair })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair.mock.calls[0][0]).toBe('no json here')
    expect(repair.mock.calls[0][1]).toBeInstanceOf(ContractError)
    expect(r).toEqual({ ok: true, value: { summary: 'fixed', topics: ['x'] }, repairedBy: 'call' })
  })

  it('asks at most once, and returns the reason of the second failure', async () => {
    const repair = vi.fn(async () => '{"summary":"","topics":[]}')
    const r = await runContract({ contract: summary, call: async () => 'nope', repair })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('schema-mismatch')
  })

  it('does not ask for a repair when the call gave nothing, and fails as empty', async () => {
    const repair = vi.fn()
    const r = await runContract({ contract: summary, call: async () => null, repair })
    expect(repair).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('empty')
  })

  it('fails without a repair function, and when the repair call gives nothing', async () => {
    const noRepair = await runContract({ contract: summary, call: async () => 'nope' })
    expect(noRepair.ok).toBe(false)
    const emptyRepair = await runContract({ contract: summary, call: async () => 'nope', repair: async () => null })
    expect(emptyRepair.ok).toBe(false)
  })
})
