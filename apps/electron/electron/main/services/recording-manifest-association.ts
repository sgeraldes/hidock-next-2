import { createHash } from 'crypto'
import { RecordedAudioState } from './recorded-audio-state'
import {
  assertRecordingManifestBinding,
  parseRecordingManifest
} from '../../../src/shared/recording-manifest'
import type { RecordingClockEvidence, RecordingManifest } from '../../../src/shared/recording-manifest'
import type { RecordedAudioLayout, RecordedAudioRole } from '../../../src/shared/recorded-audio-layout'

interface AssociationDatabase {
  run(sql: string, params?: any[]): unknown
  exec(sql: string, params?: any[]): Array<{ columns: string[]; values: any[][] }>
}

export interface ManifestOriginRequest {
  localRecordingId: string
  originalSha256: string
  manifestSha256: string
  deviceRecordingId: string
  contentGeneration: string
}

/** Evidence that only the authorized device owner can issue, bound to one manifest and one original. */
export interface ManifestOriginAttestation {
  evidenceId: string
  originalSha256: string
  manifestSha256: string
  deviceRecordingId: string
  contentGeneration: string
}

export interface RecordingManifestAssociationDeps {
  db: AssociationDatabase
  /** Answered by the sole device owner, never by renderer input or manifest content. */
  isCapabilityAvailable(): boolean
  /** Returns null when the owner cannot vouch for this exact manifest and original. */
  attestManifestOrigin(request: ManifestOriginRequest): ManifestOriginAttestation | null
}

export interface AssociateRecordingManifestInput {
  localRecordingId: string
  manifestPayload: string | null | undefined
  measured: {
    sha256: string
    byteLength: number
    layout: RecordedAudioLayout
    clockEvidence?: RecordingClockEvidence
  }
}

/** Same shape as association: a fresh raw payload, fresh measurements, fresh owner attestation. */
export type UpdatePresentationMetadataInput = AssociateRecordingManifestInput

export type UnavailableCode = 'capability-unavailable' | 'capability-check-failed' | 'manifest-absent'
export type RejectCode =
  | 'invalid-input'
  | 'recording-not-found'
  | 'manifest-invalid'
  | 'open-recording'
  | 'binding-mismatch'
  | 'clock-evidence-missing'
  | 'origin-unverified'
  | 'layout-conflict'
  | 'manifest-conflict'
  | 'generation-conflict'
  | 'mapping-conflict'
  | 'association-missing'
  | 'identity-conflict'
  | 'metadata-conflict'
  | 'storage-failed'

type Failure =
  | { status: 'unavailable'; code: UnavailableCode }
  | { status: 'rejected'; code: RejectCode; detail?: string }

export type RecordingManifestAssociationResult =
  | { status: 'associated'; mapping: 'written' | 'preserved' | 'none' }
  | { status: 'unchanged' }
  | Failure

export type RecordingManifestUpdateResult =
  | { status: 'updated'; change: 'file-name' | 'serialization' }
  | { status: 'unchanged' }
  | Failure

export interface StoredRecordingManifestAssociation {
  recordingId: string
  originalSha256: string
  deviceRecordingId: string
  contentGeneration: string
  manifestSha256: string
  evidenceId: string
  clockEvidenceId: string | null
  manifest: RecordingManifest
  sourceMap: Array<{ channelIndex: number; role: RecordedAudioRole }>
}

/** One attested payload. `rawManifest` is null only for rows written before this history existed. */
export interface RecordingManifestRevision {
  revision: number
  manifestSha256: string
  evidenceId: string
  fileName: string
  rawManifest: string | null
}

const SHA256 = /^[a-f0-9]{64}$/
const SAVEPOINT = 'recording_manifest_association'
const quarantinedConnections = new WeakMap<AssociationDatabase, string>()

function recoveryRequiredMessage(cause: string): string {
  return `Recording manifest database connection requires recovery: close it and reopen a fresh connection. Previous savepoint failure: ${cause}`
}

const rejected = (code: RejectCode, detail?: string): Failure => ({
  status: 'rejected',
  code,
  ...(detail === undefined ? {} : { detail })
})
const unavailable = (code: UnavailableCode): Failure => ({ status: 'unavailable', code })
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function sameLayout(a: RecordedAudioLayout, b: RecordedAudioLayout): boolean {
  return (
    a.container === b.container &&
    a.codec === b.codec &&
    a.channels === b.channels &&
    a.sampleRate === b.sampleRate &&
    a.durationSeconds === b.durationSeconds &&
    a.durationSource === b.durationSource &&
    a.bitrateKbps === b.bitrateKbps &&
    a.originalSha256 === b.originalSha256
  )
}

function attestationBinds(
  attestation: ManifestOriginAttestation | null,
  expected: Omit<ManifestOriginAttestation, 'evidenceId'>
): attestation is ManifestOriginAttestation {
  return (
    !!attestation &&
    typeof attestation.evidenceId === 'string' &&
    !!attestation.evidenceId.trim() &&
    attestation.evidenceId.length <= 512 &&
    attestation.originalSha256 === expected.originalSha256 &&
    attestation.manifestSha256 === expected.manifestSha256 &&
    attestation.deviceRecordingId === expected.deviceRecordingId &&
    attestation.contentGeneration === expected.contentGeneration
  )
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sortedSourceMap = (manifest: RecordingManifest) =>
  manifest.audio.sourceMap
    .map((row) => ({ channelIndex: row.channelIndex, role: row.role }))
    .sort((a, b) => a.channelIndex - b.channelIndex)

/** Everything a rename must leave alone, as sections of the manifest. Only `file.name` is presentation. */
function changedSections(before: RecordingManifest, after: RecordingManifest): string[] {
  const { clock: beforeClock, sourceMap: _beforeMap, ...beforeAudio } = before.audio
  const { clock: afterClock, sourceMap: _afterMap, ...afterAudio } = after.audio
  const { name: _beforeName, ...beforeFile } = before.file
  const { name: _afterName, ...afterFile } = after.file
  const sections: Array<[string, unknown, unknown]> = [
    ['source-map', sortedSourceMap(before), sortedSourceMap(after)],
    ['clock', beforeClock, afterClock],
    ['markers', before.markers, after.markers],
    [
      'other',
      { schemaVersion: before.schemaVersion, state: before.state, file: beforeFile, audio: beforeAudio },
      { schemaVersion: after.schemaVersion, state: after.state, file: afterFile, audio: afterAudio }
    ]
  ]
  return sections.filter(([, a, b]) => canonicalJson(a) !== canonicalJson(b)).map(([name]) => name)
}

type Prepared =
  | { ok: false; failure: Failure }
  | {
      ok: true
      localRecordingId: string
      manifest: RecordingManifest
      payload: string
      manifestSha256: string
      measured: AssociateRecordingManifestInput['measured']
    }

/**
 * Backend-only association of an owner-attested recording manifest. Nothing here registers a
 * capability, IPC handler, download hook or firmware call; the owner supplies the callbacks.
 */
export class RecordingManifestAssociationService {
  private readonly audio: RecordedAudioState

  constructor(private readonly deps: RecordingManifestAssociationDeps) {
    this.audio = new RecordedAudioState(deps.db)
  }

  associate(input: AssociateRecordingManifestInput): RecordingManifestAssociationResult {
    const recoveryFailure = this.connectionRecoveryFailure()
    if (recoveryFailure) return recoveryFailure
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared.failure
    const { localRecordingId, manifest, payload, manifestSha256, measured } = prepared

    const attested = this.attest(localRecordingId, manifest, manifestSha256, measured.sha256)
    if ('status' in attested) return attested

    try {
      return this.persist({
        localRecordingId,
        manifest,
        payload,
        manifestSha256,
        evidenceId: attested.evidenceId,
        clockEvidenceId: manifest.audio.clock ? (measured.clockEvidence?.evidenceId ?? null) : null,
        layout: measured.layout
      })
    } catch (error) {
      return rejected('storage-failed', messageOf(error))
    }
  }

  /**
   * Rename-only update of an existing association. A fresh owner attestation of the exact new raw
   * payload is mandatory, even when only whitespace or key order changed. Identity, generation,
   * source SHA, roles, clock, markers and every other field must stay semantically equal; only
   * `file.name` may differ. Mappings, including user-confirmed ones, are never touched.
   */
  updatePresentationMetadata(input: UpdatePresentationMetadataInput): RecordingManifestUpdateResult {
    const recoveryFailure = this.connectionRecoveryFailure()
    if (recoveryFailure) return recoveryFailure
    const prepared = this.prepare(input)
    if (!prepared.ok) return prepared.failure
    const { localRecordingId: id, manifest, payload, manifestSha256, measured } = prepared
    const sha = measured.sha256

    let stored: StoredRecordingManifestAssociation | null
    let storedLayout: RecordedAudioLayout | null
    try {
      stored = this.readRow(id, sha)
      storedLayout = stored ? this.audio.getLayout(id, sha) : null
    } catch (error) {
      return rejected('storage-failed', messageOf(error))
    }
    if (!stored) return rejected('association-missing')
    if (stored.deviceRecordingId !== manifest.recordingId || stored.contentGeneration !== manifest.contentGeneration)
      return rejected('identity-conflict')
    if (!storedLayout || !sameLayout(storedLayout, measured.layout)) return rejected('layout-conflict')
    const changed = changedSections(stored.manifest, manifest)
    if (changed.length > 0) return rejected('metadata-conflict', `changed: ${changed.join(', ')}`)

    const attested = this.attest(id, manifest, manifestSha256, sha)
    if ('status' in attested) return attested
    if (stored.manifestSha256 === manifestSha256) return { status: 'unchanged' }

    const change = stored.manifest.file.name !== manifest.file.name ? 'file-name' : 'serialization'
    try {
      this.inSavepoint(() => {
        this.ensureSchema()
        if (
          this.rows('SELECT 1 FROM recording_manifest_association_history WHERE recording_id=? AND source_sha=?', [id, sha])
            .length === 0
        )
          this.insertRevision(id, sha, 1, stored.manifestSha256, stored.evidenceId, stored.manifest.file.name, null)
        const revision =
          Number(
            this.rows(
              'SELECT COALESCE(MAX(revision),0) FROM recording_manifest_association_history WHERE recording_id=? AND source_sha=?',
              [id, sha]
            )[0][0]
          ) + 1
        this.deps.db.run(
          `UPDATE recording_manifest_associations SET manifest_sha256=?,evidence_id=?,clock_evidence_id=?,manifest_json=?
           WHERE recording_id=? AND source_sha=?`,
          [
            manifestSha256,
            attested.evidenceId,
            manifest.audio.clock ? (measured.clockEvidence?.evidenceId ?? null) : null,
            JSON.stringify(manifest),
            id,
            sha
          ]
        )
        this.insertRevision(id, sha, revision, manifestSha256, attested.evidenceId, manifest.file.name, payload)
      })
    } catch (error) {
      return rejected('storage-failed', messageOf(error))
    }
    return { status: 'updated', change }
  }

  get(localRecordingId: string, originalSha256: string): StoredRecordingManifestAssociation | null {
    this.assertConnectionReadable()
    if (!localRecordingId?.trim() || !SHA256.test(originalSha256)) return null
    return this.readRow(localRecordingId, originalSha256)
  }

  /** Attested payloads in order. Each `rawManifest` hashes to its `manifestSha256`. */
  getRevisions(localRecordingId: string, originalSha256: string): RecordingManifestRevision[] {
    this.assertConnectionReadable()
    if (!localRecordingId?.trim() || !SHA256.test(originalSha256) || !this.tableExists('recording_manifest_association_history'))
      return []
    return this.rows(
      `SELECT revision,manifest_sha256,evidence_id,file_name,raw_manifest FROM recording_manifest_association_history
       WHERE recording_id=? AND source_sha=? ORDER BY revision`,
      [localRecordingId, originalSha256]
    ).map((row) => ({
      revision: Number(row[0]),
      manifestSha256: String(row[1]),
      evidenceId: String(row[2]),
      fileName: String(row[3]),
      rawManifest: row[4] === null ? null : String(row[4])
    }))
  }

  private prepare(input: AssociateRecordingManifestInput): Prepared {
    const { localRecordingId, manifestPayload, measured } = input
    const fail = (failure: Failure): Prepared => ({ ok: false, failure })
    if (typeof localRecordingId !== 'string' || !localRecordingId.trim() || !SHA256.test(String(measured?.sha256)))
      return fail(rejected('invalid-input'))

    try {
      if (this.deps.isCapabilityAvailable() !== true) return fail(unavailable('capability-unavailable'))
    } catch {
      return fail(unavailable('capability-check-failed'))
    }
    if (manifestPayload === null || manifestPayload === undefined) return fail(unavailable('manifest-absent'))
    if (typeof manifestPayload !== 'string') return fail(rejected('manifest-invalid'))

    try {
      if (this.rows('SELECT 1 FROM recordings WHERE id=?', [localRecordingId]).length === 0)
        return fail(rejected('recording-not-found'))
    } catch (error) {
      return fail(rejected('storage-failed', messageOf(error)))
    }

    let manifest: RecordingManifest
    try {
      manifest = parseRecordingManifest(manifestPayload)
    } catch (error) {
      return fail(rejected('manifest-invalid', messageOf(error)))
    }

    try {
      assertRecordingManifestBinding(manifest, measured)
    } catch (error) {
      const detail = messageOf(error)
      if (/^Open recording/.test(detail)) return fail(rejected('open-recording', detail))
      if (/capture clock/.test(detail)) return fail(rejected('clock-evidence-missing', detail))
      return fail(rejected('binding-mismatch', detail))
    }

    return {
      ok: true,
      localRecordingId,
      manifest,
      payload: manifestPayload,
      manifestSha256: createHash('sha256').update(Buffer.from(manifestPayload, 'utf8')).digest('hex'),
      measured
    }
  }

  private attest(
    localRecordingId: string,
    manifest: RecordingManifest,
    manifestSha256: string,
    originalSha256: string
  ): ManifestOriginAttestation | Failure {
    const expected = {
      originalSha256,
      manifestSha256,
      deviceRecordingId: manifest.recordingId,
      contentGeneration: manifest.contentGeneration
    }
    let attestation: ManifestOriginAttestation | null
    try {
      attestation = this.deps.attestManifestOrigin({ localRecordingId, ...expected })
    } catch (error) {
      return rejected('origin-unverified', messageOf(error))
    }
    return attestationBinds(attestation, expected) ? attestation : rejected('origin-unverified')
  }

  private readRow(id: string, sha: string): StoredRecordingManifestAssociation | null {
    if (!this.tableExists('recording_manifest_associations')) return null
    const row = this.rows(
      `SELECT device_recording_id,content_generation,manifest_sha256,evidence_id,clock_evidence_id,manifest_json,source_map_json
       FROM recording_manifest_associations WHERE recording_id=? AND source_sha=?`,
      [id, sha]
    )[0]
    if (!row) return null
    return {
      recordingId: id,
      originalSha256: sha,
      deviceRecordingId: String(row[0]),
      contentGeneration: String(row[1]),
      manifestSha256: String(row[2]),
      evidenceId: String(row[3]),
      clockEvidenceId: row[4] === null ? null : String(row[4]),
      manifest: JSON.parse(String(row[5])),
      sourceMap: JSON.parse(String(row[6]))
    }
  }

  private persist(ctx: {
    localRecordingId: string
    manifest: RecordingManifest
    payload: string
    manifestSha256: string
    evidenceId: string
    clockEvidenceId: string | null
    layout: RecordedAudioLayout
  }): RecordingManifestAssociationResult {
    const { localRecordingId: id, manifest, payload, manifestSha256, evidenceId, clockEvidenceId, layout } = ctx
    const sha = layout.originalSha256

    if (this.tableExists('recording_manifest_associations')) {
      const current = this.rows(
        'SELECT manifest_sha256 FROM recording_manifest_associations WHERE recording_id=? AND source_sha=?',
        [id, sha]
      )[0]
      if (current) return current[0] === manifestSha256 ? { status: 'unchanged' } : rejected('manifest-conflict')
      const sibling = this.rows(
        'SELECT 1 FROM recording_manifest_associations WHERE device_recording_id=? AND content_generation=? AND source_sha<>?',
        [manifest.recordingId, manifest.contentGeneration, sha]
      )
      if (sibling.length > 0) return rejected('generation-conflict')
    }

    const storedLayout = this.audio.getLayout(id, sha)
    if (storedLayout && !sameLayout(storedLayout, layout)) return rejected('layout-conflict')

    const sourceMap = sortedSourceMap(manifest)
    const roles = sourceMap.map((row) => row.role)

    let mapping: 'written' | 'preserved' | 'none' = 'none'
    if (roles.some((role) => role !== 'unknown')) {
      const previous = this.audio.getMapping(id, sha)
      if (!previous) mapping = 'written'
      else if (previous.roles.length === roles.length && previous.roles.every((role, i) => role === roles[i]))
        mapping = 'preserved'
      else return rejected('mapping-conflict')
    }

    this.inSavepoint(() => {
      this.ensureSchema()
      if (!storedLayout) this.audio.saveLayout(id, { ...layout })
      this.deps.db.run(
        `INSERT INTO recording_manifest_associations(recording_id,source_sha,device_recording_id,content_generation,
          manifest_sha256,evidence_id,clock_evidence_id,manifest_json,source_map_json) VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          id,
          sha,
          manifest.recordingId,
          manifest.contentGeneration,
          manifestSha256,
          evidenceId,
          clockEvidenceId,
          JSON.stringify(manifest),
          JSON.stringify(sourceMap)
        ]
      )
      this.insertRevision(id, sha, 1, manifestSha256, evidenceId, manifest.file.name, payload)
      if (mapping === 'written')
        this.audio.setMapping(id, sha, { evidence: 'verified-recorded-metadata', evidenceId, roles })
    })
    return { status: 'associated', mapping }
  }

  /**
   * Runs `work` inside one savepoint. Any failure, including opening or releasing it, is rethrown as
   * the original message plus what happened to the savepoint. A failed ROLLBACK TO leaves the
   * savepoint open on purpose: releasing it would fold the partial writes into the outer transaction.
   */
  private inSavepoint(work: () => void): void {
    const db = this.deps.db
    let opened = false
    let failure: unknown
    try {
      db.run(`SAVEPOINT ${SAVEPOINT}`)
      opened = true
      work()
      db.run(`RELEASE ${SAVEPOINT}`)
      return
    } catch (error) {
      failure = error
    }
    const notes = [opened ? 'savepoint opened' : 'savepoint not opened']
    let unresolved = false
    if (opened) {
      let rolledBack = false
      try {
        db.run(`ROLLBACK TO ${SAVEPOINT}`)
        rolledBack = true
      } catch (error) {
        unresolved = true
        notes.push(`rollback failed: ${messageOf(error)}; savepoint left open`)
      }
      if (rolledBack) {
        try {
          db.run(`RELEASE ${SAVEPOINT}`)
        } catch (error) {
          unresolved = true
          notes.push(`release failed: ${messageOf(error)}; savepoint left open`)
        }
      }
    }
    const detail = `${messageOf(failure)} [${notes.join('; ')}]`
    if (unresolved) quarantinedConnections.set(db, detail)
    throw new Error(detail)
  }

  private connectionRecoveryFailure(): Extract<Failure, { status: 'rejected' }> | null {
    const cause = quarantinedConnections.get(this.deps.db)
    return cause === undefined
      ? null
      : { status: 'rejected', code: 'storage-failed', detail: recoveryRequiredMessage(cause) }
  }

  private assertConnectionReadable(): void {
    const failure = this.connectionRecoveryFailure()
    if (failure) throw new Error(failure.detail)
  }

  private insertRevision(
    id: string,
    sha: string,
    revision: number,
    manifestSha256: string,
    evidenceId: string,
    fileName: string,
    rawManifest: string | null
  ): void {
    this.deps.db.run(
      `INSERT INTO recording_manifest_association_history(recording_id,source_sha,revision,manifest_sha256,evidence_id,file_name,raw_manifest)
       VALUES(?,?,?,?,?,?,?)`,
      [id, sha, revision, manifestSha256, evidenceId, fileName, rawManifest]
    )
  }

  private ensureSchema(): void {
    this.deps.db.run(`CREATE TABLE IF NOT EXISTS recording_manifest_associations (
      recording_id TEXT NOT NULL, source_sha TEXT NOT NULL, device_recording_id TEXT NOT NULL,
      content_generation TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, evidence_id TEXT NOT NULL,
      clock_evidence_id TEXT, manifest_json TEXT NOT NULL, source_map_json TEXT NOT NULL,
      PRIMARY KEY(recording_id,source_sha),
      FOREIGN KEY(recording_id,source_sha) REFERENCES recording_audio_layouts(recording_id,source_sha) ON DELETE CASCADE)`)
    this.deps.db.run(`CREATE INDEX IF NOT EXISTS idx_recording_manifest_device_identity
      ON recording_manifest_associations(device_recording_id,content_generation)`)
    this.deps.db.run(`CREATE TABLE IF NOT EXISTS recording_manifest_association_history (
      recording_id TEXT NOT NULL, source_sha TEXT NOT NULL, revision INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL,
      evidence_id TEXT NOT NULL, file_name TEXT NOT NULL, raw_manifest TEXT,
      PRIMARY KEY(recording_id,source_sha,revision),
      FOREIGN KEY(recording_id,source_sha) REFERENCES recording_manifest_associations(recording_id,source_sha) ON DELETE CASCADE)`)
  }

  private tableExists(name: string): boolean {
    return this.rows("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0
  }

  private rows(sql: string, params?: any[]): any[][] {
    return this.deps.db.exec(sql, params)[0]?.values ?? []
  }
}
