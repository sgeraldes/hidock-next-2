/**
 * The Library toast's "Recover N from the device" action.
 *
 * The main process rebuilds the plan and queues the replacements in the
 * ordinary download queue, so they show up in the download progress UI like
 * any other download. Queued files are registered as an explicit request
 * (requestScopedDownloads) so they are processed even with auto-download off,
 * the same way a Library "Download" click is.
 */

import { toast } from '@/components/ui/toaster'
import { requestScopedDownloads, drainDownloadQueue } from '@/hooks/useDownloadOrchestrator'

export async function recoverTruncated(): Promise<number> {
  try {
    const result = await window.electronAPI.downloadService.recoverTruncated()
    const queued = result?.queued ?? []
    if (queued.length === 0) {
      toast.info(
        'Nothing queued',
        result?.skipped?.[0]?.reason ?? 'The HiDock no longer lists a larger copy of these recordings.'
      )
      return 0
    }
    requestScopedDownloads(queued)
    drainDownloadQueue()
    toast.success(
      `${queued.length} recover${queued.length === 1 ? 'y' : 'ies'} queued`,
      'Each file on disk is replaced only after the complete copy has downloaded and measured longer.'
    )
    return queued.length
  } catch (e) {
    toast.error('Recovery not queued', e instanceof Error ? e.message : 'Unknown error')
    return 0
  }
}
