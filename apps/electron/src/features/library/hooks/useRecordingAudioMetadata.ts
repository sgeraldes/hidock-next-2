import { useEffect, useState } from 'react'
import type { RecordingAudioMetadata } from '@/shared/audio-header-metadata'

/** A selected audio only: stale responses cannot replace the next source's facts. */
export function useRecordingAudioMetadata(
  recordingId: string | null,
  sourceRevision: string | null = recordingId
): RecordingAudioMetadata | null {
  const [result, setResult] = useState<{ id: string; revision: string | null; data: RecordingAudioMetadata } | null>(null)
  useEffect(() => {
    let active = true
    setResult(null)
    if (!recordingId || !window.electronAPI?.storage?.getAudioMetadata) return
    void window.electronAPI.storage.getAudioMetadata(recordingId).then((response) => {
      if (!active) return
      setResult(response.success && response.data ? { id: recordingId, revision: sourceRevision, data: response.data } : null)
    }).catch(() => { /* Unsupported older main process keeps unknown fields unknown. */ })
    return () => { active = false }
  }, [recordingId, sourceRevision])
  return result?.id === recordingId && result.revision === sourceRevision ? result.data : null
}
