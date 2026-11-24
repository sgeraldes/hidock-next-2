const LANGUAGE_CODE = /^[a-z]{2,3}$/i

export interface RemoteWorkerLanguageResolution {
  language: string
  reportedLanguage: string | null
  requestedLanguage: string
  languageSource: 'reported' | 'requested' | 'unresolved'
}

function normalized(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function isConcreteLanguage(value: string | undefined): boolean {
  return value !== undefined && LANGUAGE_CODE.test(value) && value.toLowerCase() !== 'und'
}

/** Resolve only language codes actually reported or requested; never infer a detected language. */
export function resolveRemoteWorkerLanguage(reported: unknown, requested: unknown): RemoteWorkerLanguageResolution {
  const reportedValue = normalized(reported)
  const requestedValue = normalized(requested)
  const requestedLanguage = typeof requested === 'string' ? requested : 'auto'
  const reportedLanguage = typeof reported === 'string' ? reported : null

  if (reportedValue && isConcreteLanguage(reportedValue)) {
    return { language: reportedValue.toLowerCase(), reportedLanguage, requestedLanguage, languageSource: 'reported' }
  }
  if (requestedValue && isConcreteLanguage(requestedValue)) {
    return { language: requestedValue.toLowerCase(), reportedLanguage, requestedLanguage, languageSource: 'requested' }
  }

  const unresolved = [reportedValue, requestedValue]
    .filter((value): value is string => Boolean(value))
    .find(value => ['auto', 'unknown', 'und'].includes(value.toLowerCase()))
  return { language: unresolved ?? 'auto', reportedLanguage, requestedLanguage, languageSource: 'unresolved' }
}
