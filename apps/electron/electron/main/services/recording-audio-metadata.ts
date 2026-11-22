import type { RecordingAudioMetadata } from '../../../src/shared/audio-header-metadata'
import { readAudioHeaderMetadata } from './audio-header-metadata'
import { getRecordingById } from './database'

export interface AudioMetadataDependencies {
  getRecording: (id: string) => { file_path?: string | null } | undefined
  readHeader: typeof readAudioHeaderMetadata
}

/** Owner may inspect their trashed audio too. Refuse purged IDs and changed paths after I/O. */
export async function getRecordingAudioMetadata(
  recordingId: unknown,
  dependencies: AudioMetadataDependencies = { getRecording: getRecordingById, readHeader: readAudioHeaderMetadata }
): Promise<{ success: boolean; data?: RecordingAudioMetadata; error?: string }> {
  if (typeof recordingId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(recordingId)) {
    return { success: false, error: 'Invalid recording ID' }
  }
  try {
    const row = dependencies.getRecording(recordingId)
    if (!row?.file_path) return { success: false, error: 'Local audio unavailable' }
    const metadata = await dependencies.readHeader(row.file_path)
    const current = dependencies.getRecording(recordingId)
    if (!current?.file_path || current.file_path !== row.file_path) {
      return { success: false, error: 'Recording changed or was removed' }
    }
    const { source: _source, io: _io, ...data } = metadata
    return { success: true, data }
  } catch {
    return { success: false, error: 'Audio metadata unavailable' }
  }
}
