// @vitest-environment node

/**
 * Reading the model's answer.
 *
 * Everything here is about not trusting it: a model asked for JSON returns
 * fenced JSON, chatty JSON, a category nobody offered, or nothing at all, and
 * none of those may reach the database.
 */

import { describe, expect, it, vi } from 'vitest'

// The module reaches the brains, which reach the config, which reaches
// Electron's app. Nothing under test here calls any of it.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
    getName: vi.fn().mockReturnValue('test'),
  },
}))

import { NOTE_CATEGORIES, parseAnalysis } from '../note-intelligence'

describe('parseAnalysis', () => {
  const good = {
    title: 'Presupuesto de septiembre',
    summary: 'Dos líneas sobre el presupuesto.',
    category: 'decision',
    tags: ['presupuesto', 'finanzas'],
  }

  it('reads a plain JSON answer', () => {
    expect(parseAnalysis(JSON.stringify(good))).toEqual({
      suggestedTitle: 'Presupuesto de septiembre',
      summary: 'Dos líneas sobre el presupuesto.',
      category: 'decision',
      tags: ['presupuesto', 'finanzas'],
    })
  })

  it('reads it through a code fence', () => {
    const fenced = '```json\n' + JSON.stringify(good) + '\n```'
    expect(parseAnalysis(fenced)?.category).toBe('decision')
  })

  it('reads it out of a chatty answer', () => {
    const chatty = `Sure, here you go:\n${JSON.stringify(good)}\nLet me know if you want more.`
    expect(parseAnalysis(chatty)?.suggestedTitle).toBe('Presupuesto de septiembre')
  })

  it('is null when there is no object at all', () => {
    expect(parseAnalysis('I cannot help with that.')).toBe(null)
    expect(parseAnalysis('')).toBe(null)
    expect(parseAnalysis(null)).toBe(null)
  })

  it('is null for an object it cannot parse', () => {
    expect(parseAnalysis('{ title: unquoted }')).toBe(null)
  })

  it('forces an invented category back to other', () => {
    // A free-text category grows the filter a bucket per hallucination.
    const invented = parseAnalysis(JSON.stringify({ ...good, category: 'quarterly-planning' }))
    expect(invented?.category).toBe('other')
  })

  it('accepts every category it offered, case-insensitively', () => {
    for (const category of NOTE_CATEGORIES) {
      expect(parseAnalysis(JSON.stringify({ ...good, category: category.toUpperCase() }))?.category)
        .toBe(category)
    }
  })

  it('drops tags that are not strings and caps how many there are', () => {
    const messy = parseAnalysis(
      JSON.stringify({ ...good, tags: ['uno', 2, null, 'dos', 'tres', 'cuatro', 'cinco', 'seis'] })
    )
    expect(messy?.tags).toEqual(['uno', 'dos', 'tres', 'cuatro', 'cinco'])
  })

  it('takes a missing summary as missing, not as the string null', () => {
    const noSummary = parseAnalysis(JSON.stringify({ ...good, summary: null }))
    expect(noSummary?.summary).toBe(null)
  })

  it('does not let a long answer become a long row', () => {
    const long = parseAnalysis(
      JSON.stringify({ ...good, title: 'x'.repeat(5000), summary: 'y'.repeat(5000) })
    )
    expect(long?.suggestedTitle?.length).toBe(200)
    expect(long?.summary?.length).toBe(1000)
  })
})
