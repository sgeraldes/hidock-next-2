import { describe, expect, it } from 'vitest'
import { alignLinesToWords, normalizeWords, WORD_ALIGN_MIN_MATCH, type HostWord } from '../transcript-word-aligner'

/** Words spoken at a steady pace from `at`, 0.4 s each with a 0.1 s gap. */
function spoken(text: string, at: number): HostWord[] {
  return text.split(' ').map((word, i) => ({ word, start: at + i * 0.5, end: at + i * 0.5 + 0.4 }))
}

describe('normalizeWords', () => {
  it('folds case, accents and punctuation the same way on both sides', () => {
    expect(normalizeWords('¿Qué tal, Manuel? ¡Ciento veinte!')).toEqual(['que', 'tal', 'manuel', 'ciento', 'veinte'])
    expect(normalizeWords('it\'s 120')).toEqual(['it', 's', '120'])
  })
})

describe('alignLinesToWords', () => {
  const window = { start: 0, end: 30 }

  it('puts each line on the time its own words were heard', () => {
    const words = [...spoken('hola manuel como estas', 4.9), ...spoken('bien gracias y vos', 12)]
    const result = alignLinesToWords([{ text: 'Hola, Manuel. ¿Cómo estás?' }, { text: 'Bien, gracias, ¿y vos?' }], window, words)
    expect(result.ok).toBe(true)
    expect(result.method).toBe('model-host-words')
    expect(result.starts[0]).toBeCloseTo(4.9, 2)
    expect(result.starts[1]).toBeCloseTo(12, 2)
    expect(result.ends[0]).toBeCloseTo(6.8, 2)
    expect(result.confidence).toBe(1)
  })

  it('ignores speech the transcript does not have before, between and after its lines', () => {
    const words = [...spoken('final de la frase anterior', 0.5), ...spoken('hola manuel', 5), ...spoken('eh bueno', 7),
      ...spoken('vamos a empezar', 9), ...spoken('otra persona habla', 20)]
    const result = alignLinesToWords([{ text: 'Hola Manuel' }, { text: 'Vamos a empezar' }], window, words)
    expect(result.ok).toBe(true)
    expect(result.starts[0]).toBeCloseTo(5, 2)
    expect(result.starts[1]).toBeCloseTo(9, 2)
  })

  it('tolerates the recogniser mishearing some words', () => {
    const words = spoken('hola manuel como estan', 3)
    const result = alignLinesToWords([{ text: 'Hola Manuel, ¿cómo estás?' }], window, words)
    expect(result.ok).toBe(true)
    expect(result.starts[0]).toBeCloseTo(3, 2)
    expect(result.confidence).toBeGreaterThan(0.7)
  })

  it('starts a line earlier when its first words were not heard', () => {
    const words = spoken('reunion de las diez', 6)
    const result = alignLinesToWords([{ text: 'Bueno entonces la reunión de las diez' }], window, words)
    expect(result.ok).toBe(true)
    expect(result.starts[0]).toBeLessThan(6)
    expect(result.starts[0]).toBeGreaterThanOrEqual(window.start)
  })

  it('places a line with no heard words between its anchored neighbours', () => {
    const words = [...spoken('primera linea aqui', 2), ...spoken('tercera linea final', 14)]
    const result = alignLinesToWords([{ text: 'Primera línea aquí' }, { text: 'Zzz qqq' }, { text: 'Tercera línea final' }], window, words)
    expect(result.starts[1]).toBeGreaterThan(result.ends[0] - 1e-9)
    expect(result.starts[1]).toBeLessThan(result.starts[2])
  })

  it('keeps starts in order and apart, and inside the window', () => {
    const words = spoken('si si si si', 10)
    const result = alignLinesToWords([{ text: 'Sí' }, { text: 'Sí' }, { text: 'Sí sí' }], { start: 9, end: 12 }, words)
    for (let i = 1; i < result.starts.length; i++) expect(result.starts[i]).toBeGreaterThanOrEqual(result.starts[i - 1] + 0.1 - 1e-9)
    for (const s of result.starts) { expect(s).toBeGreaterThanOrEqual(9); expect(s).toBeLessThanOrEqual(12) }
    for (let i = 0; i < result.ends.length; i++) expect(result.ends[i]).toBeGreaterThan(result.starts[i])
  })

  it('refuses when too few of the words were heard', () => {
    const words = spoken('algo completamente distinto dicho aqui', 3)
    const result = alignLinesToWords([{ text: 'Hola Manuel, ¿cómo estás hoy?' }], window, words)
    expect(result.ok).toBe(false)
    expect(result.confidence).toBeLessThan(WORD_ALIGN_MIN_MATCH)
    expect(result.reason).toMatch(/heard/)
  })

  it('refuses when nothing was heard', () => {
    const result = alignLinesToWords([{ text: 'Hola' }], window, [])
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no words/i)
  })

  it('refuses a section too large to match in one go instead of stalling the main process', () => {
    const lines = Array.from({ length: 400 }, () => ({ text: 'una dos tres cuatro cinco seis siete ocho nueve diez' }))
    const words = Array.from({ length: 4000 }, (_, i) => ({ word: 'palabra', start: i * 0.2, end: i * 0.2 + 0.1 }))
    const result = alignLinesToWords(lines, { start: 0, end: 900 }, words)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/too long/)
  })
})
