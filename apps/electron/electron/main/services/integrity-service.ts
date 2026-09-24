/**
 * Data Integrity Service
 *
 * Ensures consistency between:
 * - Device files (HiDock)
 * - Local file system (recordings folder)
 * - Database records (recordings, synced_files tables)
 *
 * Runs checks on startup and provides on-demand health checks.
 */

import { existsSync, readdirSync, statSync, unlinkSync, utimesSync } from 'fs'
import { join, basename, dirname, extname } from 'path'
import {
  getDatabase,
  queryAll,
  run,
  saveDatabase,
  getRecordingByFilename,
  getSyncedFile,
  addSyncedFile,
  removeSyncedFile,
  Recording,
  SyncedFile
} from './database'
import { getRecordingsPath } from './file-storage'
import { getActiveTranscriptions } from './transcription-activity'

// =============================================================================
// Types
// =============================================================================

export interface IntegrityIssue {
  id: string
  type: 'orphaned_download' | 'missing_file' | 'orphaned_file' | 'date_mismatch' | 'size_mismatch' | 'incomplete_download'
  severity: 'low' | 'medium' | 'high'
  description: string
  filePath?: string
  filename?: string
  recordingId?: string
  suggestedAction: 'delete' | 'repair' | 'ignore' | 'manual'
  autoRepairable: boolean
  details?: Record<string, unknown>
}

export interface IntegrityReport {
  scanStarted: string
  scanCompleted: string
  totalIssues: number
  issuesByType: Record<string, number>
  issuesBySeverity: Record<string, number>
  issues: IntegrityIssue[]
  autoRepairableCount: number
}

export interface RepairResult {
  issueId: string
  success: boolean
  action: string
  error?: string
}

// =============================================================================
// Filename Date Parsing
// =============================================================================

// Shared parser (single source of truth) — re-exported here so existing
// consumers of this module keep working.
import { parseHiDockFilenameDate } from './hidock-filename'
export { parseHiDockFilenameDate } from './hidock-filename'

/**
 * Generate a proper filename with date prefix from an original date
 */
function generateCorrectFilename(originalFilename: string, recordingDate: Date): string {
  const datePrefix = recordingDate.toISOString().split('T')[0]
  const timePrefix = `${String(recordingDate.getHours()).padStart(2, '0')}${String(recordingDate.getMinutes()).padStart(2, '0')}`

  // Extract existing suffix (like -meeting-name.wav) if present
  const ext = extname(originalFilename)
  const base = basename(originalFilename, ext)

  // Check if there's already a description suffix after the time
  const suffixMatch = base.match(/-([^-]+)$/)
  const suffix = suffixMatch ? `-${suffixMatch[1]}` : ''

  return `${datePrefix}_${timePrefix}${suffix}${ext === '.hda' ? '.wav' : ext}`
}

// =============================================================================
// Integrity Service
// =============================================================================

class IntegrityService {
  private lastReport: IntegrityReport | null = null

  /**
   * Run all startup integrity checks
   * Called when the app initializes
   */
  async runStartupChecks(): Promise<{ issuesFound: number; issuesFixed: number }> {
    console.log('[IntegrityService] Running startup integrity checks...')

    let issuesFound = 0
    let issuesFixed = 0

    try {
      // 1. Reset orphaned downloads (stuck in 'downloading' status)
      const orphanedResult = this.resetOrphanedDownloads()
      issuesFound += orphanedResult.found
      issuesFixed += orphanedResult.fixed
    } catch (error) {
      console.error('[IntegrityService] Error resetting orphaned downloads:', error)
    }

    try {
      // 2. Reset stuck transcriptions
      const transcriptionResult = this.resetStuckTranscriptions()
      issuesFound += transcriptionResult.found
      issuesFixed += transcriptionResult.fixed
    } catch (error) {
      console.error('[IntegrityService] Error resetting stuck transcriptions:', error)
    }

    try {
      // 3. Fix file dates that don't match filenames (bug from prior downloads)
      const dateResult = await this.fixFileDates()
      issuesFound += dateResult.found
      issuesFixed += dateResult.fixed
    } catch (error) {
      console.error('[IntegrityService] Error fixing file dates:', error)
    }

    try {
      // 4. Repair empty-string meeting links left by the pre-2026-07-24 unlink
      // bug (meeting_id = '' instead of NULL + standalone marker)
      const linkResult = this.repairEmptyMeetingLinks()
      issuesFound += linkResult.found
      issuesFixed += linkResult.fixed
    } catch (error) {
      console.error('[IntegrityService] Error repairing empty meeting links:', error)
    }

    try {
      // 5. D-022: re-link recordings whose audio is on disk but whose file_path
      // was cleared. They are invisible everywhere else — the download service
      // refuses them and transcription rejects them — so nothing but this check
      // brings them back.
      const relinkResult = this.relinkLocalRecordings()
      issuesFound += relinkResult.found
      issuesFixed += relinkResult.fixed
    } catch (error) {
      console.error('[IntegrityService] Error re-linking local recordings:', error)
    }

    console.log(`[IntegrityService] Startup checks complete: ${issuesFound} issues found, ${issuesFixed} fixed`)
    return { issuesFound, issuesFixed }
  }

  /**
   * Repair rows left with `meeting_id = ''` by the old unlink path (it wrote an
   * empty string instead of NULL — neither a valid link nor a clean unlink).
   * An empty id was only ever written by a failed UNLINK attempt, so the row's
   * intent was "standalone": normalize to NULL + the standalone marker.
   */
  repairEmptyMeetingLinks(): { found: number; fixed: number } {
    const stale = queryAll<{ id: string }>(`SELECT id FROM recordings WHERE meeting_id = ''`)
    if (stale.length === 0) return { found: 0, fixed: 0 }
    console.log(`[IntegrityService] Repairing ${stale.length} recording(s) with empty-string meeting links`)
    for (const row of stale) {
      run(
        `UPDATE recordings SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = 'user_preassign_standalone' WHERE id = ?`,
        [row.id]
      )
      run(
        `UPDATE knowledge_captures SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = NULL, updated_at = CURRENT_TIMESTAMP WHERE source_recording_id = ?`,
        [row.id]
      )
    }
    saveDatabase()
    return { found: stale.length, fixed: stale.length }
  }

  /**
   * D-022 — find the audio for a recording, whatever it ended up being called.
   *
   * Two sources, in order of authority:
   *   1. the synced_files row, which is the download path's own record of where
   *      it put the file (it survives a move of the recordings directory);
   *   2. the canonical name variants in the CURRENT recordings directory, for
   *      when that row was lost or never written.
   *
   * .hda is checked last but is checked: 89 recordings legitimately point at
   * one. Returns null only when the audio is genuinely not here.
   */
  private locateLocalAudio(filename: string): string | null {
    const base = filename.replace(/\.(hda|wav|mp3|m4a|flac)$/i, '')
    const extensions = ['.wav', '.mp3', '.m4a', '.flac', '.hda']

    // synced_files is keyed by the DEVICE-NATIVE name (.hda), while a local
    // recordings row is often named .wav or .mp3. Looking the row up under the
    // recording's own name alone would miss the authoritative path for exactly
    // those rows, so try every variant.
    for (const candidateName of [filename, ...extensions.map((ext) => base + ext)]) {
      const row = getSyncedFile(candidateName)
      if (row?.file_path && existsSync(row.file_path)) return row.file_path
    }

    const dir = getRecordingsPath()
    for (const ext of extensions) {
      const candidate = join(dir, base + ext)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  /**
   * D-022 — is this path's own directory unreachable?
   *
   * The recordings sit on an external drive. "The file was deleted" and "the
   * volume is not mounted" are the same observation from a single existsSync,
   * and every repair below treats the first as licence to destroy something. A
   * missing file whose FOLDER is also missing is not evidence of deletion.
   */
  private volumeUnreachable(filePath: string | null | undefined): boolean {
    return !!filePath && !existsSync(dirname(filePath))
  }

  /**
   * D-022 — the single decision every repair path needs: given a recording
   * whose stored path does not resolve, what is actually true?
   *
   *   'relinked'    the audio was found elsewhere and the row now points at it
   *   'unreachable' the volume is offline; change nothing and retry later
   *   'claimed'     another recording already owns that audio (duplicate shadow
   *                 row) — leave it to the org-reconciler's merge
   *   'gone'        the storage is readable and the audio is genuinely absent
   *
   * Only 'gone' may lead to erasing anything.
   */
  private resolveRelink(
    filename: string | undefined,
    recordingId: string,
    storedPath?: string | null
  ): 'relinked' | 'unreachable' | 'claimed' | 'gone' {
    if (this.volumeUnreachable(storedPath)) return 'unreachable'
    if (!filename) return 'gone'

    const located = this.locateLocalAudio(filename)
    if (!located) {
      // No audio found — but if the recordings directory itself cannot be read,
      // that is an unmounted drive, not a deletion.
      return existsSync(getRecordingsPath()) ? 'gone' : 'unreachable'
    }
    if (this.audioClaimedByAnother(located, recordingId)) return 'claimed'

    run(
      `UPDATE recordings SET file_path = ?, on_local = 1, location =
         CASE WHEN on_device = 1 THEN 'both' ELSE 'local' END
       WHERE id = ?`,
      [located, recordingId]
    )
    // Keep synced_files agreeing with what we just proved.
    addSyncedFile(filename, basename(located), located)
    return 'relinked'
  }

  /**
   * D-022 — is this file already spoken for by a different recording?
   *
   * Duplicate shadow rows are common (the .hda twin of a take downloaded as
   * .wav). Pointing a second row at the same audio would show the take twice in
   * the Library and let it be transcribed twice, at full provider cost. Merging
   * duplicates belongs to the org-reconciler; repair just declines to create one.
   */
  private audioClaimedByAnother(filePath: string, recordingId: string): boolean {
    // Stored paths and path.join() output can disagree on the separator, and two
    // spellings of one file are still one file. Ask for both.
    const backslashed = filePath.replace(/\//g, '\\')
    const forwardSlashed = filePath.replace(/\\/g, '/')
    try {
      return queryAll<{ id: string }>(
        `SELECT id FROM recordings
         WHERE (file_path = ? OR file_path = ?) AND id != ? AND deleted_at IS NULL
         LIMIT 1`,
        [backslashed, forwardSlashed, recordingId]
      ).length > 0
    } catch {
      // A lookup we cannot complete is not permission to duplicate.
      return true
    }
  }

  /**
   * D-022 — re-link recordings whose audio is on disk but whose pointer is gone.
   *
   * These rows are invisible by construction: the Library shows them as
   * device-only, the download service refuses to fetch them (a synced_files row
   * says they are already here), and transcription rejects them for having no
   * local file. Nothing else in the app looks for a recording that has no path
   * but does have a file, so this check is the only way back for them.
   */
  relinkLocalRecordings(): { found: number; fixed: number } {
    const stranded = queryAll<Recording>(`
      SELECT * FROM recordings
      WHERE (file_path IS NULL OR file_path = '')
        AND deleted_at IS NULL
    `)

    if (stranded.length === 0) return { found: 0, fixed: 0 }

    let fixed = 0
    for (const rec of stranded) {
      try {
        // 'unreachable' (drive offline), 'claimed' (duplicate shadow row) and
        // 'gone' (genuinely device-only) all mean: change nothing.
        if (this.resolveRelink(rec.filename, rec.id) === 'relinked') fixed++
      } catch (error) {
        console.error(`[IntegrityService] Failed to re-link ${rec.filename}:`, error)
      }
    }

    if (fixed > 0) {
      saveDatabase()
      console.log(
        `[IntegrityService] Re-linked ${fixed} recording(s) whose audio was on disk but whose ` +
        'file_path had been cleared — they were invisible to download AND transcription'
      )
    }
    return { found: stranded.length, fixed }
  }

  /**
   * Reset downloads that are stuck in 'downloading' status
   * This happens when the app crashes during a download
   *
   * Performance optimized: Uses batch updates instead of individual queries
   */
  resetOrphanedDownloads(): { found: number; fixed: number } {
    console.log('[IntegrityService] Checking for orphaned downloads...')

    // Find recordings that have file_path set but on_local = 0 (inconsistent state)
    const stuckRecordings = queryAll<Recording>(`
      SELECT * FROM recordings
      WHERE on_local = 0
        AND file_path IS NOT NULL
        AND file_path != ''
    `)

    if (stuckRecordings.length === 0) {
      console.log('[IntegrityService] No orphaned downloads found')
      return { found: 0, fixed: 0 }
    }

    console.log(`[IntegrityService] Found ${stuckRecordings.length} recordings to check...`)

    // Batch categorize: files that exist vs files that are missing
    const existingFileIds: string[] = []
    const missingFileIds: string[] = []
    let relinkedCount = 0
    let unresolvedCount = 0

    for (const rec of stuckRecordings) {
      if (!rec.file_path) continue

      if (existsSync(rec.file_path)) {
        existingFileIds.push(rec.id)
        continue
      }

      // D-022 — the stored path is dead, but that is not the same as the audio
      // being gone. This branch used to go straight to `file_path = NULL`, which
      // is how recordings lost the only pointer they had while their files sat
      // on disk. Establish what is actually true before discarding anything.
      let outcome: ReturnType<typeof this.resolveRelink>
      try {
        outcome = this.resolveRelink(rec.filename, rec.id, rec.file_path)
      } catch (error) {
        console.error(`[IntegrityService] Failed to re-link ${rec.filename}:`, error)
        outcome = 'unreachable' // an error is not proof the file is gone
      }

      if (outcome === 'relinked') {
        relinkedCount++
        continue
      }
      if (outcome === 'unreachable' || outcome === 'claimed') {
        unresolvedCount++
        continue // keep the pointer; this is not evidence of deletion
      }

      missingFileIds.push(rec.id)
    }

    let fixed = relinkedCount

    // Batch update: files that exist - set on_local = 1
    if (existingFileIds.length > 0) {
      console.log(`[IntegrityService] Fixing on_local flag for ${existingFileIds.length} recordings with existing files...`)
      try {
        // SQLite supports up to ~1000 parameters, batch in chunks if needed
        const chunkSize = 500
        for (let i = 0; i < existingFileIds.length; i += chunkSize) {
          const chunk = existingFileIds.slice(i, i + chunkSize)
          const placeholders = chunk.map(() => '?').join(',')
          run(`UPDATE recordings SET on_local = 1, location = 'both' WHERE id IN (${placeholders})`, chunk)
        }
        fixed += existingFileIds.length
      } catch (error) {
        console.error('[IntegrityService] Batch update failed, falling back to individual updates:', error)
        for (const id of existingFileIds) {
          try {
            run(`UPDATE recordings SET on_local = 1, location = 'both' WHERE id = ?`, [id])
            fixed++
          } catch (err) {
            console.error(`[IntegrityService] Failed to fix on_local for id ${id}:`, err)
          }
        }
      }
    }

    // Batch update: files that are missing - reset state
    if (missingFileIds.length > 0) {
      console.log(`[IntegrityService] Resetting ${missingFileIds.length} recordings with missing files...`)
      try {
        const chunkSize = 500
        for (let i = 0; i < missingFileIds.length; i += chunkSize) {
          const chunk = missingFileIds.slice(i, i + chunkSize)
          const placeholders = chunk.map(() => '?').join(',')
          run(`UPDATE recordings SET file_path = NULL, on_local = 0, location = 'device-only' WHERE id IN (${placeholders})`, chunk)
        }
        fixed += missingFileIds.length
      } catch (error) {
        console.warn('[IntegrityService] Batch NULL update failed, trying empty string:', error)
        try {
          const chunkSize = 500
          for (let i = 0; i < missingFileIds.length; i += chunkSize) {
            const chunk = missingFileIds.slice(i, i + chunkSize)
            const placeholders = chunk.map(() => '?').join(',')
            run(`UPDATE recordings SET file_path = '', on_local = 0, location = 'device-only' WHERE id IN (${placeholders})`, chunk)
          }
          fixed += missingFileIds.length
        } catch (innerError) {
          console.error('[IntegrityService] Batch update failed completely:', innerError)
        }
      }
    }

    if (fixed > 0) {
      saveDatabase()
    }

    console.log(
      `[IntegrityService] Orphaned downloads: ${stuckRecordings.length} checked, ${fixed} fixed ` +
      `(${existingFileIds.length} files exist, ${relinkedCount} re-linked after moving, ` +
      `${unresolvedCount} left alone (offline volume or duplicate), ${missingFileIds.length} missing)`
    )
    return { found: stuckRecordings.length, fixed }
  }

  /**
   * Reset transcriptions stuck in 'processing' or 'transcribing' status
   */
  resetStuckTranscriptions(): { found: number; fixed: number } {
    console.log('[IntegrityService] Checking for stuck transcriptions...')

    const db = getDatabase()
    // A recording this process is transcribing right now is not stuck: this
    // check runs after the window paints, when the queue may already be busy.
    const live = getActiveTranscriptions()
    const keep = live.length > 0 ? live : ['']
    const marks = keep.map(() => '?').join(', ')

    // Reset stuck recordings
    const stuckRecordings = queryAll<{ id: string }>(
      `SELECT id FROM recordings WHERE status = 'transcribing' AND id NOT IN (${marks})`,
      keep
    )

    if (stuckRecordings.length > 0) {
      db.run(`UPDATE recordings SET status = 'pending' WHERE status = 'transcribing' AND id NOT IN (${marks})`, keep)
    }

    // Reset stuck queue items
    const stuckQueue = queryAll<{ id: string }>(
      `SELECT id FROM transcription_queue WHERE status = 'processing' AND recording_id NOT IN (${marks})`,
      keep
    )

    if (stuckQueue.length > 0) {
      db.run(`UPDATE transcription_queue SET status = 'pending' WHERE status = 'processing' AND recording_id NOT IN (${marks})`, keep)
    }

    const totalFixed = stuckRecordings.length + stuckQueue.length
    if (totalFixed > 0) {
      saveDatabase()
      console.log(`[IntegrityService] Reset ${stuckRecordings.length} recordings and ${stuckQueue.length} queue items`)
    }

    return { found: totalFixed, fixed: totalFixed }
  }

  /**
   * Fix file dates that don't match the filename.
   * This repairs files downloaded with wrong dates (bug prior to date preservation fix).
   * Updates both file mtime and database date_recorded.
   */
  async fixFileDates(): Promise<{ found: number; fixed: number }> {
    console.log('[IntegrityService] Checking for files with wrong dates...')
    const recordingsPath = getRecordingsPath()

    if (!existsSync(recordingsPath)) {
      return { found: 0, fixed: 0 }
    }

    const files = readdirSync(recordingsPath)
    const audioExtensions = ['.wav', '.mp3', '.m4a', '.ogg', '.webm']
    const oneHourMs = 60 * 60 * 1000

    let found = 0
    let fixed = 0

    for (const file of files) {
      const ext = extname(file).toLowerCase()
      if (!audioExtensions.includes(ext)) continue

      const filePath = join(recordingsPath, file)
      const filenameDate = parseHiDockFilenameDate(file)

      if (!filenameDate) {
        // Can't parse date from filename, skip
        continue
      }

      try {
        const stats = statSync(filePath)
        const mtimeDiff = Math.abs(stats.mtime.getTime() - filenameDate.getTime())

        // If mtime differs from filename date by more than 1 hour, fix it
        if (mtimeDiff > oneHourMs) {
          found++
          console.log(`[IntegrityService] Fixing date for: ${file} (mtime was ${stats.mtime.toISOString()}, should be ${filenameDate.toISOString()})`)

          try {
            // 1. Fix the file's modification time
            utimesSync(filePath, filenameDate, filenameDate)

            // 2. Update the database if there's a recording entry
            const hdaName = file.replace(/\.wav$/i, '.hda')
            const recording = getRecordingByFilename(file) || getRecordingByFilename(hdaName)
            if (recording) {
              run(`UPDATE recordings SET date_recorded = ? WHERE id = ?`, [filenameDate.toISOString(), recording.id])
            }

            fixed++
          } catch (error) {
            console.error(`[IntegrityService] Failed to fix date for ${file}:`, error)
          }
        }
      } catch {
        // Skip files we can't stat
      }
    }

    if (fixed > 0) {
      saveDatabase()
      // A repaired date_recorded changes what a recording overlaps — re-run the
      // batch auto-linker so rows whose dates were just corrected (e.g. files
      // that arrived with the copy time) get their meeting link now, not on
      // some later calendar sync. Lazy import keeps this module cycle-free.
      try {
        const { autoLinkRecordingsToMeetings } = await import('./org-reconciler')
        const linked = autoLinkRecordingsToMeetings()
        if (linked > 0) {
          console.log(`[IntegrityService] Auto-linked ${linked} recording(s) after date repairs`)
        }
      } catch (linkError) {
        console.error('[IntegrityService] Auto-link after date repairs failed:', linkError)
      }
    }

    console.log(`[IntegrityService] File dates: ${found} files with wrong dates, ${fixed} fixed`)
    return { found, fixed }
  }

  /**
   * Run a full integrity scan
   * Returns a detailed report of all issues found
   */
  async runFullScan(): Promise<IntegrityReport> {
    console.log('[IntegrityService] Starting full integrity scan...')
    const startTime = new Date()
    const issues: IntegrityIssue[] = []

    // 1. Check for orphaned downloads
    issues.push(...this.findOrphanedDownloads())

    // 2. Check for missing files (in DB but not on disk)
    issues.push(...this.findMissingFiles())

    // 3. Check for orphaned files (on disk but not in DB)
    issues.push(...this.findOrphanedFiles())

    // 4. Check for date mismatches
    issues.push(...this.findDateMismatches())

    // 5. Check for size mismatches
    issues.push(...this.findSizeMismatches())

    // 6. Check for incomplete downloads (partial files)
    issues.push(...this.findIncompleteDownloads())

    const endTime = new Date()

    // Build report
    const issuesByType: Record<string, number> = {}
    const issuesBySeverity: Record<string, number> = {}
    let autoRepairableCount = 0

    for (const issue of issues) {
      issuesByType[issue.type] = (issuesByType[issue.type] || 0) + 1
      issuesBySeverity[issue.severity] = (issuesBySeverity[issue.severity] || 0) + 1
      if (issue.autoRepairable) autoRepairableCount++
    }

    const report: IntegrityReport = {
      scanStarted: startTime.toISOString(),
      scanCompleted: endTime.toISOString(),
      totalIssues: issues.length,
      issuesByType,
      issuesBySeverity,
      issues,
      autoRepairableCount
    }

    this.lastReport = report
    console.log(`[IntegrityService] Scan complete: ${issues.length} issues found`)
    return report
  }

  /**
   * Find downloads stuck in downloading state
   */
  private findOrphanedDownloads(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []

    // Check for recordings with file_path set but file doesn't exist
    const recordings = queryAll<Recording>(`
      SELECT * FROM recordings
      WHERE file_path IS NOT NULL AND file_path != ''
    `)

    for (const rec of recordings) {
      if (rec.file_path && !existsSync(rec.file_path)) {
        issues.push({
          id: `orphaned_download_${rec.id}`,
          type: 'orphaned_download',
          severity: 'medium',
          description: `Recording "${rec.filename}" has file_path set but file does not exist`,
          filename: rec.filename,
          filePath: rec.file_path,
          recordingId: rec.id,
          suggestedAction: 'repair',
          autoRepairable: true,
          details: {
            expected_path: rec.file_path,
            on_local: rec.on_local,
            location: rec.location
          }
        })
      }
    }

    return issues
  }

  /**
   * Find files that are in the database but missing from disk
   */
  private findMissingFiles(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []

    // Check synced_files table
    const syncedFiles = queryAll<SyncedFile>('SELECT * FROM synced_files')

    for (const sf of syncedFiles) {
      if (!existsSync(sf.file_path)) {
        issues.push({
          id: `missing_file_synced_${sf.id}`,
          type: 'missing_file',
          severity: 'medium',
          description: `Synced file "${sf.local_filename}" is missing from disk`,
          filename: sf.original_filename,
          filePath: sf.file_path,
          suggestedAction: 'repair',
          autoRepairable: true,
          details: {
            synced_at: sf.synced_at,
            expected_size: sf.file_size
          }
        })
      }
    }

    return issues
  }

  /**
   * Find files on disk that aren't tracked in the database
   */
  private findOrphanedFiles(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []
    const recordingsPath = getRecordingsPath()

    if (!existsSync(recordingsPath)) {
      return issues
    }

    const files = readdirSync(recordingsPath)
    const audioExtensions = ['.wav', '.mp3', '.m4a', '.ogg', '.webm', '.hda']

    for (const file of files) {
      const ext = extname(file).toLowerCase()
      if (!audioExtensions.includes(ext)) continue

      const filePath = join(recordingsPath, file)

      // Check if it's in synced_files
      const synced = getSyncedFile(file)
      if (synced) continue

      // Check if it's in recordings (by filename or wav equivalent)
      const hdaName = file.replace(/\.wav$/i, '.hda')
      const recording = getRecordingByFilename(file) || getRecordingByFilename(hdaName)

      if (!recording) {
        const stats = statSync(filePath)
        issues.push({
          id: `orphaned_file_${file}`,
          type: 'orphaned_file',
          severity: 'low',
          description: `File "${file}" exists on disk but is not tracked in database`,
          filename: file,
          filePath,
          suggestedAction: 'repair',
          autoRepairable: true,
          details: {
            size: stats.size,
            modified: stats.mtime.toISOString()
          }
        })
      }
    }

    return issues
  }

  /**
   * Find recordings with suspicious dates (e.g., year 2000, far future dates)
   * Also detects files where the filename date doesn't match the file mtime
   */
  private findDateMismatches(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []
    const now = new Date()
    const minValidDate = new Date('2020-01-01') // HiDock devices weren't made before 2020
    const maxValidDate = new Date(now.getTime() + 24 * 60 * 60 * 1000) // 1 day in future max

    // 1. Check database recordings for invalid/suspicious dates
    const recordings = queryAll<Recording>('SELECT * FROM recordings')

    for (const rec of recordings) {
      const dateRecorded = new Date(rec.date_recorded)

      if (isNaN(dateRecorded.getTime())) {
        issues.push({
          id: `date_invalid_${rec.id}`,
          type: 'date_mismatch',
          severity: 'high',
          description: `Recording "${rec.filename}" has invalid date: ${rec.date_recorded}`,
          filename: rec.filename,
          recordingId: rec.id,
          suggestedAction: 'manual',
          autoRepairable: false,
          details: { raw_date: rec.date_recorded }
        })
        continue
      }

      if (dateRecorded < minValidDate) {
        issues.push({
          id: `date_too_old_${rec.id}`,
          type: 'date_mismatch',
          severity: 'medium',
          description: `Recording "${rec.filename}" has suspicious old date: ${dateRecorded.toISOString()}`,
          filename: rec.filename,
          recordingId: rec.id,
          suggestedAction: 'repair',
          autoRepairable: true,
          details: {
            recorded_date: dateRecorded.toISOString(),
            suggested_date: rec.created_at // Use created_at as fallback
          }
        })
      } else if (dateRecorded > maxValidDate) {
        issues.push({
          id: `date_future_${rec.id}`,
          type: 'date_mismatch',
          severity: 'medium',
          description: `Recording "${rec.filename}" has future date: ${dateRecorded.toISOString()}`,
          filename: rec.filename,
          recordingId: rec.id,
          suggestedAction: 'repair',
          autoRepairable: true,
          details: {
            recorded_date: dateRecorded.toISOString(),
            suggested_date: now.toISOString()
          }
        })
      }
    }

    // 2. Scan recordings folder for files where mtime doesn't match filename date
    // This catches files that were downloaded with wrong dates (bug prior to fix)
    const recordingsPath = getRecordingsPath()
    if (existsSync(recordingsPath)) {
      const files = readdirSync(recordingsPath)
      const audioExtensions = ['.wav', '.mp3', '.m4a', '.ogg', '.webm']

      for (const file of files) {
        const ext = extname(file).toLowerCase()
        if (!audioExtensions.includes(ext)) continue

        const filePath = join(recordingsPath, file)
        const filenameDate = parseHiDockFilenameDate(file)

        if (!filenameDate) {
          // Can't parse date from filename, skip
          continue
        }

        try {
          const stats = statSync(filePath)
          const mtimeDiff = Math.abs(stats.mtime.getTime() - filenameDate.getTime())

          // If mtime differs from filename date by more than 1 hour, flag it
          // (small differences can happen due to timezone issues or processing time)
          const oneHourMs = 60 * 60 * 1000
          const oneDayMs = 24 * 60 * 60 * 1000

          if (mtimeDiff > oneDayMs) {
            // File mtime is more than a day off from filename date - likely wrong date bug
            issues.push({
              id: `file_mtime_mismatch_${file}`,
              type: 'date_mismatch',
              severity: 'high',
              description: `File "${file}" has mtime (${stats.mtime.toISOString()}) that doesn't match filename date (${filenameDate.toISOString()})`,
              filename: file,
              filePath,
              suggestedAction: 'repair',
              autoRepairable: true,
              details: {
                file_mtime: stats.mtime.toISOString(),
                filename_date: filenameDate.toISOString(),
                difference_hours: Math.round(mtimeDiff / oneHourMs),
                correct_filename: generateCorrectFilename(file, filenameDate)
              }
            })
          } else if (mtimeDiff > oneHourMs) {
            // Minor mismatch, still worth noting
            issues.push({
              id: `file_mtime_minor_${file}`,
              type: 'date_mismatch',
              severity: 'low',
              description: `File "${file}" has minor time mismatch (${Math.round(mtimeDiff / 60000)} minutes)`,
              filename: file,
              filePath,
              suggestedAction: 'repair',
              autoRepairable: true,
              details: {
                file_mtime: stats.mtime.toISOString(),
                filename_date: filenameDate.toISOString(),
                difference_minutes: Math.round(mtimeDiff / 60000)
              }
            })
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }

    return issues
  }

  /**
   * Find files where database size doesn't match actual file size
   */
  private findSizeMismatches(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []

    const recordings = queryAll<Recording>(`
      SELECT * FROM recordings
      WHERE file_path IS NOT NULL AND file_size IS NOT NULL
    `)

    for (const rec of recordings) {
      if (!rec.file_path || !existsSync(rec.file_path)) continue

      try {
        const stats = statSync(rec.file_path)
        const sizeDiff = Math.abs(stats.size - (rec.file_size || 0))

        // Allow 5% tolerance for metadata differences
        const tolerance = (rec.file_size || 0) * 0.05

        if (sizeDiff > tolerance && sizeDiff > 1024) { // More than 1KB difference
          issues.push({
            id: `size_mismatch_${rec.id}`,
            type: 'size_mismatch',
            severity: 'low',
            description: `Recording "${rec.filename}" size mismatch: DB=${rec.file_size}, Disk=${stats.size}`,
            filename: rec.filename,
            filePath: rec.file_path,
            recordingId: rec.id,
            suggestedAction: 'repair',
            autoRepairable: true,
            details: {
              db_size: rec.file_size,
              disk_size: stats.size,
              difference: sizeDiff
            }
          })
        }
      } catch {
        // File may have been deleted, skip
      }
    }

    return issues
  }

  /**
   * Find downloads that may be incomplete (very small files, 0 bytes, etc.)
   */
  private findIncompleteDownloads(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []
    const recordingsPath = getRecordingsPath()

    if (!existsSync(recordingsPath)) return issues

    const files = readdirSync(recordingsPath)
    const audioExtensions = ['.wav', '.mp3', '.m4a']

    for (const file of files) {
      const ext = extname(file).toLowerCase()
      if (!audioExtensions.includes(ext)) continue

      const filePath = join(recordingsPath, file)

      try {
        const stats = statSync(filePath)

        // WAV files should have at least a header (44 bytes) + some data
        // Files under 1KB are likely incomplete
        if (stats.size < 1024) {
          issues.push({
            id: `incomplete_${file}`,
            type: 'incomplete_download',
            severity: 'high',
            description: `File "${file}" appears incomplete (${stats.size} bytes)`,
            filename: file,
            filePath,
            suggestedAction: 'delete',
            autoRepairable: true,
            details: {
              size: stats.size,
              modified: stats.mtime.toISOString()
            }
          })
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return issues
  }

  /**
   * Repair a specific issue
   */
  async repairIssue(issueId: string): Promise<RepairResult> {
    if (!this.lastReport) {
      console.error('[IntegrityService] repairIssue: No scan report available')
      return { issueId, success: false, action: 'none', error: 'No scan report available' }
    }

    const issue = this.lastReport.issues.find(i => i.id === issueId)
    if (!issue) {
      console.error('[IntegrityService] repairIssue: Issue not found:', issueId)
      return { issueId, success: false, action: 'none', error: 'Issue not found' }
    }

    if (!issue.autoRepairable) {
      console.error('[IntegrityService] repairIssue: Issue not auto-repairable:', issueId)
      return { issueId, success: false, action: 'none', error: 'Issue requires manual repair' }
    }

    try {
      switch (issue.type) {
        case 'orphaned_download':
          return this.repairOrphanedDownload(issue)
        case 'missing_file':
          return this.repairMissingFile(issue)
        case 'orphaned_file':
          return this.repairOrphanedFile(issue)
        case 'date_mismatch':
          return this.repairDateMismatch(issue)
        case 'size_mismatch':
          return this.repairSizeMismatch(issue)
        case 'incomplete_download':
          return this.repairIncompleteDownload(issue)
        default:
          return { issueId, success: false, action: 'none', error: 'Unknown issue type' }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      return { issueId, success: false, action: 'repair', error: errorMsg }
    }
  }

  /**
   * Repair all auto-repairable issues
   * Optimized: batches all repairs and saves database once at the end
   */
  async repairAllAuto(): Promise<RepairResult[]> {
    if (!this.lastReport) {
      console.log('[IntegrityService] repairAllAuto: No report available')
      return []
    }

    const autoRepairable = this.lastReport.issues.filter(i => i.autoRepairable)
    console.log(`[IntegrityService] repairAllAuto: Found ${autoRepairable.length} auto-repairable issues`)

    if (autoRepairable.length === 0) {
      return []
    }

    const startTime = Date.now()

    // Batch repair: run all repairs without individual saves
    const results = autoRepairable.map(issue => this.repairIssueBatch(issue))

    // Save database once at the end
    saveDatabase()

    const successCount = results.filter(r => r.success).length
    const elapsed = Date.now() - startTime
    console.log(`[IntegrityService] repairAllAuto complete: ${successCount}/${results.length} succeeded in ${elapsed}ms`)

    return results
  }

  /**
   * Repair a single issue without saving database (for batch operations)
   */
  private repairIssueBatch(issue: IntegrityIssue): RepairResult {
    try {
      switch (issue.type) {
        case 'orphaned_download':
          return this.repairOrphanedDownloadBatch(issue)
        case 'missing_file':
          return this.repairMissingFileBatch(issue)
        case 'orphaned_file':
          return this.repairOrphanedFileBatch(issue)
        case 'date_mismatch':
          return this.repairDateMismatchBatch(issue)
        case 'size_mismatch':
          return this.repairSizeMismatchBatch(issue)
        case 'incomplete_download':
          return this.repairIncompleteDownloadBatch(issue)
        default:
          return { issueId: issue.id, success: false, action: 'none', error: 'Unknown issue type' }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      return { issueId: issue.id, success: false, action: 'repair', error: errorMsg }
    }
  }

  // ==========================================================================
  // Repair Methods
  // ==========================================================================

  private repairOrphanedDownload(issue: IntegrityIssue): RepairResult {
    if (!issue.recordingId) {
      console.error('[IntegrityService] repairOrphanedDownload: No recording ID for issue', issue.id)
      return { issueId: issue.id, success: false, action: 'repair', error: 'No recording ID' }
    }

    try {
      // D-022 — this deletes a recordings row outright, taking its meeting link
      // and history with it, on the strength of one existsSync. That check is
      // also false for a drive that is merely unplugged and for audio that has
      // simply moved, so establish what is true first. Only 'gone' may delete.
      const outcome = this.resolveRelink(issue.filename, issue.recordingId, issue.filePath)
      if (outcome === 'relinked') {
        saveDatabase()
        return { issueId: issue.id, success: true, action: 'Re-linked the recording to its audio' }
      }
      if (outcome === 'unreachable') {
        return {
          issueId: issue.id,
          success: false,
          action: 'repair',
          error: 'The storage holding this recording is unreachable — leaving it untouched'
        }
      }
      if (outcome === 'claimed') {
        return {
          issueId: issue.id,
          success: false,
          action: 'repair',
          error: 'Another recording already owns that audio — left for duplicate merging'
        }
      }

      // Delete the orphaned recording record - the file is already gone
      // When device reconnects, a fresh record will be created with correct filename
      console.log('[IntegrityService] Deleting orphaned recording:', issue.recordingId, issue.filename)
      run(`DELETE FROM recordings WHERE id = ?`, [issue.recordingId])
      saveDatabase()
      console.log('[IntegrityService] Successfully deleted orphaned recording:', issue.recordingId)
      return { issueId: issue.id, success: true, action: 'Deleted orphaned recording record' }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      console.error('[IntegrityService] repairOrphanedDownload error:', errorMsg)
      return { issueId: issue.id, success: false, action: 'repair', error: errorMsg }
    }
  }

  private repairMissingFile(issue: IntegrityIssue): RepairResult {
    if (!issue.filename) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No filename' }
    }

    const recording = getRecordingByFilename(issue.filename)
    const outcome = this.resolveRelink(issue.filename, recording?.id ?? '', issue.filePath)

    if (outcome === 'relinked') {
      saveDatabase()
      return { issueId: issue.id, success: true, action: 'Re-linked to the audio on disk' }
    }
    // D-022 — an offline volume and a duplicate shadow row are both reasons to
    // leave everything alone. Falling through here would delete the synced_files
    // row that knows where the audio is, which is the erasure this fix exists
    // to stop.
    if (outcome === 'unreachable') {
      return {
        issueId: issue.id,
        success: false,
        action: 'repair',
        error: 'The storage holding this file is unreachable — leaving the tracking in place'
      }
    }
    if (outcome === 'claimed') {
      return {
        issueId: issue.id,
        success: false,
        action: 'repair',
        error: 'Another recording already owns that audio — left for duplicate merging'
      }
    }

    // Genuinely gone: drop the tracking.
    removeSyncedFile(issue.filename)

    // Also update recording if it exists
    if (recording) {
      run(`UPDATE recordings SET file_path = NULL, on_local = 0, location =
        CASE WHEN on_device = 1 THEN 'device-only' ELSE 'deleted' END
        WHERE id = ?`, [recording.id])
    }
    saveDatabase()

    return { issueId: issue.id, success: true, action: 'Removed missing file from database tracking' }
  }

  private repairOrphanedFile(issue: IntegrityIssue): RepairResult {
    if (!issue.filename || !issue.filePath) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No filename or path' }
    }

    // Add the orphaned file to synced_files
    const stats = statSync(issue.filePath)
    addSyncedFile(issue.filename, issue.filename, issue.filePath, stats.size)
    saveDatabase()

    return { issueId: issue.id, success: true, action: 'Added orphaned file to database' }
  }

  private repairDateMismatch(issue: IntegrityIssue): RepairResult {
    // Handle file mtime mismatch (fix file modification time)
    if (issue.id.startsWith('file_mtime_')) {
      if (!issue.filePath || !issue.details?.filename_date) {
        return { issueId: issue.id, success: false, action: 'repair', error: 'No file path or filename date' }
      }

      try {
        const correctDate = new Date(issue.details.filename_date as string)

        // Fix the file's modification time
        utimesSync(issue.filePath, correctDate, correctDate)

        // Also update the database if there's a recording entry
        if (issue.filename) {
          const recording = getRecordingByFilename(issue.filename)
          if (recording) {
            run(`UPDATE recordings SET date_recorded = ? WHERE id = ?`, [correctDate.toISOString(), recording.id])
            saveDatabase()
          }
        }

        return { issueId: issue.id, success: true, action: `Fixed file mtime to ${correctDate.toISOString()}` }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        return { issueId: issue.id, success: false, action: 'repair', error: errorMsg }
      }
    }

    // Handle database date mismatch (original logic)
    if (!issue.recordingId || !issue.details?.suggested_date) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No recording ID or suggested date' }
    }

    const suggestedDate = issue.details.suggested_date as string
    run(`UPDATE recordings SET date_recorded = ? WHERE id = ?`, [suggestedDate, issue.recordingId])
    saveDatabase()

    return { issueId: issue.id, success: true, action: `Updated date to ${suggestedDate}` }
  }

  private repairSizeMismatch(issue: IntegrityIssue): RepairResult {
    if (!issue.recordingId || !issue.details?.disk_size) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No recording ID or disk size' }
    }

    const diskSize = issue.details.disk_size as number
    run(`UPDATE recordings SET file_size = ? WHERE id = ?`, [diskSize, issue.recordingId])
    saveDatabase()

    return { issueId: issue.id, success: true, action: `Updated size to ${diskSize} bytes` }
  }

  private repairIncompleteDownload(issue: IntegrityIssue): RepairResult {
    if (!issue.filePath || !issue.filename) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No file path' }
    }

    // Delete the incomplete file
    try {
      unlinkSync(issue.filePath)
    } catch {
      // File may already be gone
    }

    // Remove from synced_files if present
    removeSyncedFile(issue.filename)

    // Reset recording if it exists
    const recording = getRecordingByFilename(issue.filename)
    if (recording) {
      run(`UPDATE recordings SET file_path = NULL, on_local = 0, location =
        CASE WHEN on_device = 1 THEN 'device-only' ELSE 'deleted' END
        WHERE id = ?`, [recording.id])
    }
    saveDatabase()

    return { issueId: issue.id, success: true, action: 'Deleted incomplete file and reset tracking' }
  }

  // ==========================================================================
  // Batch Repair Methods (no saveDatabase - for bulk operations)
  // ==========================================================================

  private repairOrphanedDownloadBatch(issue: IntegrityIssue): RepairResult {
    if (!issue.recordingId) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No recording ID' }
    }

    try {
      // D-022 — same rule as the single-issue path: a row is deleted only once
      // the storage is readable and the audio is genuinely not there. "Repair
      // all" against an unplugged drive used to delete every recording row.
      const outcome = this.resolveRelink(issue.filename, issue.recordingId, issue.filePath)
      if (outcome === 'relinked') {
        return { issueId: issue.id, success: true, action: 'Re-linked the recording to its audio' }
      }
      if (outcome === 'unreachable' || outcome === 'claimed') {
        return {
          issueId: issue.id,
          success: false,
          action: 'repair',
          error: outcome === 'unreachable'
            ? 'The storage holding this recording is unreachable — leaving it untouched'
            : 'Another recording already owns that audio — left for duplicate merging'
        }
      }

      run(`DELETE FROM recordings WHERE id = ?`, [issue.recordingId])
      return { issueId: issue.id, success: true, action: 'Deleted orphaned recording record' }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      return { issueId: issue.id, success: false, action: 'repair', error: errorMsg }
    }
  }

  private repairMissingFileBatch(issue: IntegrityIssue): RepairResult {
    if (!issue.filename) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No filename' }
    }

    const recording = getRecordingByFilename(issue.filename)
    const outcome = this.resolveRelink(issue.filename, recording?.id ?? '', issue.filePath)

    if (outcome === 'relinked') {
      return { issueId: issue.id, success: true, action: 'Re-linked to the audio on disk' }
    }
    if (outcome === 'unreachable' || outcome === 'claimed') {
      return {
        issueId: issue.id,
        success: false,
        action: 'repair',
        error: outcome === 'unreachable'
          ? 'The storage holding this file is unreachable — leaving the tracking in place'
          : 'Another recording already owns that audio — left for duplicate merging'
      }
    }

    // Genuinely gone: drop the tracking.
    removeSyncedFile(issue.filename)

    if (recording) {
      run(`UPDATE recordings SET file_path = NULL, on_local = 0, location =
        CASE WHEN on_device = 1 THEN 'device-only' ELSE 'deleted' END
        WHERE id = ?`, [recording.id])
    }

    return { issueId: issue.id, success: true, action: 'Removed missing file from database tracking' }
  }

  private repairOrphanedFileBatch(issue: IntegrityIssue): RepairResult {
    if (!issue.filename || !issue.filePath) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No filename or path' }
    }

    const stats = statSync(issue.filePath)
    addSyncedFile(issue.filename, issue.filename, issue.filePath, stats.size)

    return { issueId: issue.id, success: true, action: 'Added orphaned file to database' }
  }

  private repairDateMismatchBatch(issue: IntegrityIssue): RepairResult {
    if (issue.id.startsWith('file_mtime_')) {
      if (!issue.filePath || !issue.details?.filename_date) {
        return { issueId: issue.id, success: false, action: 'repair', error: 'No file path or filename date' }
      }

      try {
        const correctDate = new Date(issue.details.filename_date as string)
        utimesSync(issue.filePath, correctDate, correctDate)

        if (issue.filename) {
          const recording = getRecordingByFilename(issue.filename)
          if (recording) {
            run(`UPDATE recordings SET date_recorded = ? WHERE id = ?`, [correctDate.toISOString(), recording.id])
          }
        }

        return { issueId: issue.id, success: true, action: `Fixed file mtime to ${correctDate.toISOString()}` }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        return { issueId: issue.id, success: false, action: 'repair', error: errorMsg }
      }
    }

    if (!issue.recordingId || !issue.details?.suggested_date) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No recording ID or suggested date' }
    }

    const suggestedDate = issue.details.suggested_date as string
    run(`UPDATE recordings SET date_recorded = ? WHERE id = ?`, [suggestedDate, issue.recordingId])

    return { issueId: issue.id, success: true, action: `Updated date to ${suggestedDate}` }
  }

  private repairSizeMismatchBatch(issue: IntegrityIssue): RepairResult {
    if (!issue.recordingId || !issue.details?.disk_size) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No recording ID or disk size' }
    }

    const diskSize = issue.details.disk_size as number
    run(`UPDATE recordings SET file_size = ? WHERE id = ?`, [diskSize, issue.recordingId])

    return { issueId: issue.id, success: true, action: `Updated size to ${diskSize} bytes` }
  }

  private repairIncompleteDownloadBatch(issue: IntegrityIssue): RepairResult {
    if (!issue.filePath || !issue.filename) {
      return { issueId: issue.id, success: false, action: 'repair', error: 'No file path' }
    }

    try {
      unlinkSync(issue.filePath)
    } catch {
      // File may already be gone
    }

    removeSyncedFile(issue.filename)

    const recording = getRecordingByFilename(issue.filename)
    if (recording) {
      run(`UPDATE recordings SET file_path = NULL, on_local = 0, location =
        CASE WHEN on_device = 1 THEN 'device-only' ELSE 'deleted' END
        WHERE id = ?`, [recording.id])
    }

    return { issueId: issue.id, success: true, action: 'Deleted incomplete file and reset tracking' }
  }

  /**
   * Get the last scan report
   */
  getLastReport(): IntegrityReport | null {
    return this.lastReport
  }
}

// =============================================================================
// Singleton
// =============================================================================

let integrityServiceInstance: IntegrityService | null = null

export function getIntegrityService(): IntegrityService {
  if (!integrityServiceInstance) {
    integrityServiceInstance = new IntegrityService()
  }
  return integrityServiceInstance
}
