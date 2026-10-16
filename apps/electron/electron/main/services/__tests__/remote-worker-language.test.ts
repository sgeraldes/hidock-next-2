import { describe, expect, it } from 'vitest'
import { resolveRemoteWorkerLanguage } from '../remote-worker-language'

describe('remote worker language resolution', () => {
  it.each(['auto', 'unknown', ''])('keeps the explicit request when the result reports %j', reported => {
    const rawResult = { language: reported }
    const resolved = resolveRemoteWorkerLanguage(rawResult.language, 'es')

    expect(resolved).toEqual({ language: 'es', reportedLanguage: reported,
      requestedLanguage: 'es', languageSource: 'requested' })
    expect(rawResult.language).toBe(reported)
  })

  it('uses a concrete reported language for an autodetect request', () => {
    expect(resolveRemoteWorkerLanguage('pt', 'auto')).toEqual({ language: 'pt', reportedLanguage: 'pt',
      requestedLanguage: 'auto', languageSource: 'reported' })
  })

  it('keeps an unresolved result unresolved when neither source has a concrete language', () => {
    expect(resolveRemoteWorkerLanguage('auto', 'auto')).toEqual({ language: 'auto', reportedLanguage: 'auto',
      requestedLanguage: 'auto', languageSource: 'unresolved' })
  })
})
