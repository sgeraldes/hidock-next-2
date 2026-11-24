export type RetranscribeSkipReason = 'personal' | 'deleted' | 'missing' | 'already_queued' | 'lookup_error' | 'ineligible'

export interface RetranscribeResult {
  queued: number
  skipped: number
  skippedReasons: Partial<Record<RetranscribeSkipReason, number>>
}

export function describeRetranscribeSkips(reasons: RetranscribeResult['skippedReasons']): string {
  const labels: Record<RetranscribeSkipReason, string> = {
    personal: 'personal', deleted: 'deleted', missing: 'not found',
    already_queued: 'already queued', lookup_error: 'eligibility lookup failed', ineligible: 'not eligible'
  }
  return (Object.entries(reasons) as [RetranscribeSkipReason, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${labels[reason]}`)
    .join(', ')
}
