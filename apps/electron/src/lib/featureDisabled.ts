/**
 * Does this rejection look like main's FeatureDisabledError? Electron wraps
 * thrown handler errors, so match on the error NAME embedded in the message
 * ("FeatureDisabledError") or its stable message shape ("... is disabled (channel ...").
 */
export function isFeatureDisabledRejection(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  return text.includes('FeatureDisabledError') || text.includes('is disabled (channel')
}
