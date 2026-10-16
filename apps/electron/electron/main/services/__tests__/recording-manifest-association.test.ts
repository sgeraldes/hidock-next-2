/** @vitest-environment node */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import initSqlJs from 'sql.js'
import type { Database, SqlJsStatic } from 'sql.js'
import { createHash } from 'crypto'
vi.mock('../database', () => ({
  getDatabase: () => {
    throw new Error('Production database forbidden')
  }
}))
import { RecordedAudioState } from '../recorded-audio-state'
import {
  RecordingManifestAssociationService,
  type ManifestOriginAttestation,
  type ManifestOriginRequest
} from '../recording-manifest-association'
import type { RecordedAudioLayout } from '../../../../src/shared/recorded-audio-layout'
import type { RecordingClockEvidence } from '../../../../src/shared/recording-manifest'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const BYTE_LENGTH = 960044

const layoutFor = (sha: string): RecordedAudioLayout => ({
  container: 'wav',
  codec: 'pcm_s16le',
  channels: 2,
  sampleRate: 16000,
  durationSeconds: 15,
  durationSource: 'decoded-frames',
  originalSha256: sha
})
const clockEvidenceFor = (sha: string): RecordingClockEvidence => ({
  originalSha256: sha,
  evidenceId: 'pcm-measurement-1',
  source: 'pcm-frame-measurement',
  clock: { sampleRateHz: 16000, frameCount: 240000, encoderDelayFrames: 0, encoderPaddingFrames: 0 }
})
function manifestFor(sha: string, overrides: Record<string, unknown> = {}, roles = ['microphone', 'system']) {
  return {
    schemaVersion: 1,
    recordingId: 'device-rec-1',
    contentGeneration: 'gen-1',
    state: 'finalized',
    file: { name: '2026Oct09-130550-Rec76.wav', byteLength: BYTE_LENGTH, sha256: sha },
    audio: {
      container: 'wav',
      codec: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 2,
      bitsPerSample: 16,
      clock: { sampleRateHz: 16000, frameCount: 240000, encoderDelayFrames: 0, encoderPaddingFrames: 0 },
      sourceMap: roles.map((role, channelIndex) => ({ channelIndex, role }))
    },
    markers: [{ markerId: null, type: 'unknown', position: { unit: 'legacy-ms', value: 1500 } }],
    ...overrides
  }
}
const manifestSha = (payload: string) => createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex')

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs()
})

function newDb(): Database {
  const db = new SQL.Database()
  db.run(
    "PRAGMA foreign_keys=ON;CREATE TABLE recordings(id TEXT PRIMARY KEY);INSERT INTO recordings VALUES('rec-1'),('rec-2');CREATE TABLE old_data(value TEXT);INSERT INTO old_data VALUES('keep')"
  )
  return db
}
interface Owner {
  capability: boolean
  attest: (request: ManifestOriginRequest) => ManifestOriginAttestation | null
  requests: ManifestOriginRequest[]
}
function honestOwner(): Owner {
  const owner: Owner = {
    capability: true,
    requests: [],
    attest: (request) => {
      owner.requests.push(request)
      return {
        evidenceId: 'owner-evidence-1',
        originalSha256: request.originalSha256,
        manifestSha256: request.manifestSha256,
        deviceRecordingId: request.deviceRecordingId,
        contentGeneration: request.contentGeneration
      }
    }
  }
  return owner
}
function serviceFor(db: Pick<Database, 'run' | 'exec'>, owner: Owner) {
  return new RecordingManifestAssociationService({
    db,
    isCapabilityAvailable: () => owner.capability,
    attestManifestOrigin: (request) => owner.attest(request)
  })
}
const tableNames = (db: Database) =>
  (db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]?.values ?? []).map((r) => String(r[0]))
const count = (db: Database, table: string) => Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0])
function input(sha = SHA_A, overrides: Record<string, unknown> = {}, id = 'rec-1') {
  const payload = JSON.stringify(manifestFor(sha, overrides))
  return {
    payload,
    args: {
      localRecordingId: id,
      manifestPayload: payload,
      measured: { sha256: sha, byteLength: BYTE_LENGTH, layout: layoutFor(sha), clockEvidence: clockEvidenceFor(sha) }
    }
  }
}
const confirmedMapping = {
  evidence: 'user-confirmed' as const,
  evidenceId: 'user-confirmation-1',
  roles: ['system', 'microphone'] as Array<'system' | 'microphone'>
}
function seedUserConfirmed(db: Database) {
  const audio = new RecordedAudioState(db)
  audio.saveLayout('rec-1', layoutFor(SHA_A))
  audio.setMapping('rec-1', SHA_A, confirmedMapping)
}

describe('RecordingManifestAssociationService', () => {
  it('persists manifest identity, evidence and source map under the original SHA and survives export/reopen', () => {
    let db = newDb()
    const owner = honestOwner()
    const { payload, args } = input()
    expect(serviceFor(db, owner).associate(args)).toEqual({ status: 'associated', mapping: 'written' })
    expect(owner.requests).toEqual([
      {
        localRecordingId: 'rec-1',
        originalSha256: SHA_A,
        manifestSha256: manifestSha(payload),
        deviceRecordingId: 'device-rec-1',
        contentGeneration: 'gen-1'
      }
    ])

    const bytes = db.export()
    db.close()
    db = new SQL.Database(bytes)
    db.run('PRAGMA foreign_keys=ON')
    const stored = serviceFor(db, honestOwner()).get('rec-1', SHA_A)
    expect(stored).toMatchObject({
      recordingId: 'rec-1',
      originalSha256: SHA_A,
      deviceRecordingId: 'device-rec-1',
      contentGeneration: 'gen-1',
      manifestSha256: manifestSha(payload),
      evidenceId: 'owner-evidence-1',
      clockEvidenceId: 'pcm-measurement-1',
      sourceMap: [
        { channelIndex: 0, role: 'microphone' },
        { channelIndex: 1, role: 'system' }
      ]
    })
    expect(stored?.manifest).toEqual(JSON.parse(payload))
    expect(stored?.manifest.markers).toEqual([
      { markerId: null, type: 'unknown', position: { unit: 'legacy-ms', value: 1500 } }
    ])
    const audio = new RecordedAudioState(db)
    expect(audio.getMapping('rec-1', SHA_A)).toEqual({
      evidence: 'verified-recorded-metadata',
      evidenceId: 'owner-evidence-1',
      roles: ['microphone', 'system']
    })
    expect(audio.getLayout('rec-1', SHA_A)).toEqual(layoutFor(SHA_A))
    expect(serviceFor(db, honestOwner()).get('rec-1', SHA_B)).toBeNull()
    expect(db.exec('SELECT value FROM old_data')[0].values).toEqual([['keep']])
    expect(JSON.stringify(db.exec('SELECT manifest_json,source_map_json FROM recording_manifest_associations'))).not.toMatch(
      /[A-Za-z]:\\|\/tmp|token|apikey|secret/i
    )
    db.run("DELETE FROM recordings WHERE id='rec-1'")
    db.run("DELETE FROM recording_audio_layouts WHERE recording_id='rec-1'")
    expect(count(db, 'recording_manifest_associations')).toBe(0)
    db.close()
  })

  it('keeps unknown roles unknown and writes no mapping', () => {
    const db = newDb()
    const payload = JSON.stringify(manifestFor(SHA_A, {}, ['unknown', 'unknown']))
    const args = { ...input().args, manifestPayload: payload }
    expect(serviceFor(db, honestOwner()).associate(args)).toEqual({ status: 'associated', mapping: 'none' })
    expect(new RecordedAudioState(db).getMapping('rec-1', SHA_A)).toBeNull()
    expect(serviceFor(db, honestOwner()).get('rec-1', SHA_A)?.sourceMap.map((r) => r.role)).toEqual(['unknown', 'unknown'])
    db.close()
  })

  it('accepts a null-clock manifest without clock evidence and records no clock evidence id', () => {
    const db = newDb()
    const base = manifestFor(SHA_A)
    const payload = JSON.stringify({ ...base, audio: { ...base.audio, clock: null } })
    const args = input().args
    args.manifestPayload = payload
    args.measured.clockEvidence = undefined as never
    expect(serviceFor(db, honestOwner()).associate(args).status).toBe('associated')
    expect(serviceFor(db, honestOwner()).get('rec-1', SHA_A)?.clockEvidenceId).toBeNull()
    db.close()
  })

  describe('absent capability or manifest', () => {
    it('reports unavailable and writes nothing', () => {
      const db = newDb()
      const before = tableNames(db)
      const owner = honestOwner()
      owner.capability = false
      expect(serviceFor(db, owner).associate(input().args)).toEqual({ status: 'unavailable', code: 'capability-unavailable' })
      owner.capability = true
      expect(serviceFor(db, owner).associate({ ...input().args, manifestPayload: null })).toEqual({
        status: 'unavailable',
        code: 'manifest-absent'
      })
      expect(serviceFor(db, owner).associate({ ...input().args, manifestPayload: undefined })).toEqual({
        status: 'unavailable',
        code: 'manifest-absent'
      })
      expect(owner.requests).toEqual([])
      expect(tableNames(db)).toEqual(before)
      db.close()
    })

    it('treats a throwing capability check as unavailable', () => {
      const db = newDb()
      const service = new RecordingManifestAssociationService({
        db,
        isCapabilityAvailable: () => {
          throw new Error('usb owner gone')
        },
        attestManifestOrigin: () => null
      })
      expect(service.associate(input().args)).toEqual({ status: 'unavailable', code: 'capability-check-failed' })
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      db.close()
    })

    it('does not read capability from the manifest or any caller flag', () => {
      const db = newDb()
      const owner = honestOwner()
      owner.capability = false
      const hostile = { ...input().args, capability: true, verified: true, source: 'device-firmware' }
      expect(serviceFor(db, owner).associate(hostile as never).status).toBe('unavailable')
      db.close()
    })
  })

  describe('fail-closed rejections', () => {
    function expectRejectedAndPreserved(
      mutate: (args: ReturnType<typeof input>['args'], owner: Owner) => void,
      code: string,
      sha = SHA_A
    ) {
      const db = newDb()
      seedUserConfirmed(db)
      const owner = honestOwner()
      const { args } = input(sha)
      mutate(args, owner)
      const result = serviceFor(db, owner).associate(args)
      expect(result).toMatchObject({ status: 'rejected', code })
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      expect(new RecordedAudioState(db).getMapping('rec-1', SHA_A)).toEqual(confirmedMapping)
      db.close()
    }

    it('rejects an origin the owner will not attest', () =>
      expectRejectedAndPreserved((_a, owner) => (owner.attest = () => null), 'origin-unverified'))
    it('rejects an attestation for another original, manifest, recording or generation', () => {
      for (const field of ['originalSha256', 'manifestSha256', 'deviceRecordingId', 'contentGeneration'] as const)
        expectRejectedAndPreserved(
          (_a, owner) => {
            const honest = owner.attest
            owner.attest = (request) => ({ ...honest(request)!, [field]: field.endsWith('Sha256') ? 'c'.repeat(64) : 'other' })
          },
          'origin-unverified'
        )
    })
    it('rejects an attestation without evidence id', () =>
      expectRejectedAndPreserved((_a, owner) => {
        const honest = owner.attest
        owner.attest = (request) => ({ ...honest(request)!, evidenceId: '  ' })
      }, 'origin-unverified'))
    it('rejects a throwing owner', () =>
      expectRejectedAndPreserved((_a, owner) => {
        owner.attest = () => {
          throw new Error('boom')
        }
      }, 'origin-unverified'))
    it('rejects a measured SHA different from the manifest SHA', () =>
      expectRejectedAndPreserved((a) => {
        a.measured.sha256 = SHA_B
        a.measured.layout = layoutFor(SHA_B)
        a.measured.clockEvidence = clockEvidenceFor(SHA_B)
      }, 'binding-mismatch'))
    it('rejects a layout bound to another SHA', () =>
      expectRejectedAndPreserved((a) => (a.measured.layout = layoutFor(SHA_B)), 'binding-mismatch'))
    it('rejects a byte length mismatch', () =>
      expectRejectedAndPreserved((a) => (a.measured.byteLength = BYTE_LENGTH + 1), 'binding-mismatch'))
    it('rejects a channel/rate layout mismatch', () => {
      expectRejectedAndPreserved((a) => (a.measured.layout = { ...a.measured.layout, channels: 1 }), 'binding-mismatch')
      expectRejectedAndPreserved((a) => (a.measured.layout = { ...a.measured.layout, sampleRate: 48000 }), 'binding-mismatch')
    })
    it('rejects a claimed clock without independent evidence', () =>
      expectRejectedAndPreserved((a) => (a.measured.clockEvidence = undefined as never), 'clock-evidence-missing'))
    it('rejects clock evidence that disagrees or belongs to another original', () => {
      expectRejectedAndPreserved(
        (a) => (a.measured.clockEvidence = { ...clockEvidenceFor(SHA_A), clock: { ...clockEvidenceFor(SHA_A).clock, frameCount: 1 } }),
        'clock-evidence-missing'
      )
      expectRejectedAndPreserved((a) => (a.measured.clockEvidence = clockEvidenceFor(SHA_B)), 'clock-evidence-missing')
    })
    it('rejects an open recording', () =>
      expectRejectedAndPreserved((a) => {
        const open = manifestFor(SHA_A, { state: 'open', file: { name: 'x.wav', byteLength: 0 } })
        a.manifestPayload = JSON.stringify(open)
      }, 'open-recording'))
    it('rejects malformed, unknown-field and oversized manifests', () => {
      expectRejectedAndPreserved((a) => (a.manifestPayload = '{nope'), 'manifest-invalid')
      expectRejectedAndPreserved(
        (a) => (a.manifestPayload = JSON.stringify({ ...manifestFor(SHA_A), verified: true, origin: 'firmware' })),
        'manifest-invalid'
      )
      expectRejectedAndPreserved((a) => (a.manifestPayload = ' '.repeat(65537)), 'manifest-invalid')
    })
    it('rejects an unknown local recording id', () =>
      expectRejectedAndPreserved((a) => (a.localRecordingId = 'rec-missing'), 'recording-not-found'))
    it('rejects invalid input', () =>
      expectRejectedAndPreserved((a) => (a.localRecordingId = '  '), 'invalid-input'))
  })

  describe('previous mappings', () => {
    it('rejects a conflicting manifest without replacing a user-confirmed mapping', () => {
      const db = newDb()
      seedUserConfirmed(db)
      const result = serviceFor(db, honestOwner()).associate(input().args)
      expect(result).toMatchObject({ status: 'rejected', code: 'mapping-conflict' })
      expect(new RecordedAudioState(db).getMapping('rec-1', SHA_A)).toEqual(confirmedMapping)
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      db.close()
    })

    it('stores identity but leaves a user-confirmed mapping untouched when roles agree', () => {
      const db = newDb()
      seedUserConfirmed(db)
      const payload = JSON.stringify(manifestFor(SHA_A, {}, ['system', 'microphone']))
      const result = serviceFor(db, honestOwner()).associate({ ...input().args, manifestPayload: payload })
      expect(result).toEqual({ status: 'associated', mapping: 'preserved' })
      expect(new RecordedAudioState(db).getMapping('rec-1', SHA_A)).toEqual(confirmedMapping)
      expect(serviceFor(db, honestOwner()).get('rec-1', SHA_A)?.evidenceId).toBe('owner-evidence-1')
      db.close()
    })

    it('keeps a user-confirmed mapping when the manifest only has unknown roles', () => {
      const db = newDb()
      seedUserConfirmed(db)
      const payload = JSON.stringify(manifestFor(SHA_A, {}, ['unknown', 'unknown']))
      expect(serviceFor(db, honestOwner()).associate({ ...input().args, manifestPayload: payload })).toEqual({
        status: 'associated',
        mapping: 'none'
      })
      expect(new RecordedAudioState(db).getMapping('rec-1', SHA_A)).toEqual(confirmedMapping)
      db.close()
    })

    it('rejects a stored layout that disagrees with the measured one', () => {
      const db = newDb()
      new RecordedAudioState(db).saveLayout('rec-1', { ...layoutFor(SHA_A), durationSeconds: 14 })
      expect(serviceFor(db, honestOwner()).associate(input().args)).toMatchObject({ status: 'rejected', code: 'layout-conflict' })
      expect(count(db, 'recording_audio_layouts')).toBe(1)
      db.close()
    })
  })

  describe('atomicity', () => {
    function failing(db: Database, pattern: RegExp): Pick<Database, 'run' | 'exec'> {
      return {
        exec: (sql: string, params?: never) => db.exec(sql, params),
        run: ((sql: string, params?: never) => {
          if (pattern.test(sql)) throw new Error('disk full')
          return db.run(sql, params)
        }) as Database['run']
      }
    }

    it('rolls back layout and association when the association insert fails', () => {
      const db = newDb()
      const result = serviceFor(failing(db, /INSERT INTO recording_manifest_associations/), honestOwner()).associate(input().args)
      expect(result).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      expect(count(db, 'recording_audio_layouts')).toBe(0)
      db.close()
    })

    it('rolls back the association row when writing the mapping fails, keeping a previous layout', () => {
      const db = newDb()
      new RecordedAudioState(db).saveLayout('rec-1', layoutFor(SHA_A))
      const result = serviceFor(failing(db, /UPDATE recording_audio_layouts SET mapping_json/), honestOwner()).associate(
        input().args
      )
      expect(result).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      expect(new RecordedAudioState(db).getMapping('rec-1', SHA_A)).toBeNull()
      expect(new RecordedAudioState(db).getLayout('rec-1', SHA_A)).toEqual(layoutFor(SHA_A))
      db.close()
    })

    it('leaves the database usable after a rollback', () => {
      const db = newDb()
      serviceFor(failing(db, /INSERT INTO recording_manifest_associations/), honestOwner()).associate(input().args)
      expect(serviceFor(db, honestOwner()).associate(input().args)).toEqual({ status: 'associated', mapping: 'written' })
      db.close()
    })
  })

  describe('repetition and separation', () => {
    it('is idempotent for the same manifest and source', () => {
      const db = newDb()
      const service = serviceFor(db, honestOwner())
      expect(service.associate(input().args)).toEqual({ status: 'associated', mapping: 'written' })
      const before = JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))
      expect(service.associate(input().args)).toEqual({ status: 'unchanged' })
      expect(JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))).toBe(before)
      expect(count(db, 'recording_manifest_associations')).toBe(1)
      db.close()
    })

    it('rejects a different manifest for an already associated source and keeps the first', () => {
      const db = newDb()
      const service = serviceFor(db, honestOwner())
      service.associate(input().args)
      const other = input(SHA_A, { contentGeneration: 'gen-2' }).args
      expect(service.associate(other)).toMatchObject({ status: 'rejected', code: 'manifest-conflict' })
      expect(service.get('rec-1', SHA_A)?.contentGeneration).toBe('gen-1')
      db.close()
    })

    it('keeps different originals and recordings separate', () => {
      const db = newDb()
      const service = serviceFor(db, honestOwner())
      const second = input(SHA_B, { recordingId: 'device-rec-2' }, 'rec-2')
      const third = input(SHA_B, { recordingId: 'device-rec-3', contentGeneration: 'gen-9' }, 'rec-1')
      expect(service.associate(input().args).status).toBe('associated')
      expect(service.associate(second.args).status).toBe('associated')
      expect(service.associate(third.args).status).toBe('associated')
      expect(service.get('rec-1', SHA_A)?.deviceRecordingId).toBe('device-rec-1')
      expect(service.get('rec-2', SHA_B)?.deviceRecordingId).toBe('device-rec-2')
      expect(service.get('rec-1', SHA_B)?.deviceRecordingId).toBe('device-rec-3')
      expect(service.get('rec-2', SHA_A)).toBeNull()
      expect(count(db, 'recording_manifest_associations')).toBe(3)
      db.close()
    })

    it('does not let one device identity and generation describe two different originals', () => {
      const db = newDb()
      const service = serviceFor(db, honestOwner())
      service.associate(input().args)
      const clash = input(SHA_B, {}, 'rec-2')
      expect(service.associate(clash.args)).toMatchObject({ status: 'rejected', code: 'generation-conflict' })
      expect(service.get('rec-2', SHA_B)).toBeNull()
      db.close()
    })

    it('compares device ids case-sensitively', () => {
      const db = newDb()
      const service = serviceFor(db, honestOwner())
      service.associate(input().args)
      const upper = input(SHA_B, { recordingId: 'DEVICE-REC-1' }, 'rec-2')
      expect(service.associate(upper.args).status).toBe('associated')
      db.close()
    })
  })
})

describe('RecordingManifestAssociationService.updatePresentationMetadata', () => {
  const fileNamed = (name: string) => ({ file: { name, byteLength: BYTE_LENGTH, sha256: SHA_A } })
  const argsFor = (payload: string, id = 'rec-1', sha = SHA_A) => ({
    localRecordingId: id,
    manifestPayload: payload,
    measured: { sha256: sha, byteLength: BYTE_LENGTH, layout: layoutFor(sha), clockEvidence: clockEvidenceFor(sha) }
  })
  function evidenceOwner(): Owner {
    const owner = honestOwner()
    owner.attest = (request) => {
      owner.requests.push(request)
      return {
        evidenceId: `ev-${request.manifestSha256.slice(0, 8)}`,
        originalSha256: request.originalSha256,
        manifestSha256: request.manifestSha256,
        deviceRecordingId: request.deviceRecordingId,
        contentGeneration: request.contentGeneration
      }
    }
    return owner
  }
  const reverseKeys = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reverseKeys)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .reverse()
              .map(([key, item]) => [key, reverseKeys(item)])
          )
        : value
  function associated(roles = ['microphone', 'system']) {
    const db = newDb()
    const owner = evidenceOwner()
    const service = serviceFor(db, owner)
    const first = JSON.stringify(manifestFor(SHA_A, {}, roles))
    expect(service.associate(argsFor(first)).status).toBe('associated')
    owner.requests.length = 0
    return { db, owner, service, first }
  }
  const renamed = (name = 'renamed.wav', roles = ['microphone', 'system']) =>
    JSON.stringify(manifestFor(SHA_A, fileNamed(name), roles))

  it('renames the presentation name, keeps identity, source and map, and survives export/reopen', () => {
    const { db: original, owner, service, first } = associated()
    original.run('ALTER TABLE recordings ADD COLUMN original_filename TEXT')
    original.run("UPDATE recordings SET original_filename='device-original.wav' WHERE id='rec-1'")
    const before = service.get('rec-1', SHA_A)!
    const next = renamed()

    expect(service.updatePresentationMetadata(argsFor(next))).toEqual({ status: 'updated', change: 'file-name' })
    expect(owner.requests).toEqual([
      {
        localRecordingId: 'rec-1',
        originalSha256: SHA_A,
        manifestSha256: manifestSha(next),
        deviceRecordingId: 'device-rec-1',
        contentGeneration: 'gen-1'
      }
    ])

    const bytes = original.export()
    original.close()
    const db = new SQL.Database(bytes)
    db.run('PRAGMA foreign_keys=ON')
    const reopened = serviceFor(db, evidenceOwner())
    const after = reopened.get('rec-1', SHA_A)!
    expect(after.manifest.file.name).toBe('renamed.wav')
    expect(after).toMatchObject({
      deviceRecordingId: before.deviceRecordingId,
      contentGeneration: before.contentGeneration,
      originalSha256: SHA_A,
      sourceMap: before.sourceMap,
      clockEvidenceId: before.clockEvidenceId,
      manifestSha256: manifestSha(next),
      evidenceId: `ev-${manifestSha(next).slice(0, 8)}`
    })
    expect({ ...after.manifest, file: { ...after.manifest.file, name: 'x' } }).toEqual({
      ...before.manifest,
      file: { ...before.manifest.file, name: 'x' }
    })
    expect(reopened.getRevisions('rec-1', SHA_A)).toEqual([
      { revision: 1, manifestSha256: manifestSha(first), evidenceId: before.evidenceId, fileName: '2026Oct09-130550-Rec76.wav', rawManifest: first },
      { revision: 2, manifestSha256: manifestSha(next), evidenceId: after.evidenceId, fileName: 'renamed.wav', rawManifest: next }
    ])
    for (const revision of reopened.getRevisions('rec-1', SHA_A))
      expect(manifestSha(revision.rawManifest!)).toBe(revision.manifestSha256)
    expect(new RecordedAudioState(db).getMapping('rec-1', SHA_A)).toEqual({
      evidence: 'verified-recorded-metadata',
      evidenceId: before.evidenceId,
      roles: ['microphone', 'system']
    })
    expect(db.exec("SELECT original_filename FROM recordings WHERE id='rec-1'")[0].values).toEqual([['device-original.wav']])
    expect(reopened.get('rec-1', SHA_B)).toBeNull()
    db.close()
  })

  it('leaves a user-confirmed mapping untouched through a rename', () => {
    const db = newDb()
    seedUserConfirmed(db)
    const service = serviceFor(db, evidenceOwner())
    const roles = [...confirmedMapping.roles]
    expect(service.associate(argsFor(JSON.stringify(manifestFor(SHA_A, {}, roles))))).toEqual({
      status: 'associated',
      mapping: 'preserved'
    })
    expect(service.updatePresentationMetadata(argsFor(renamed('other.wav', roles))).status).toBe('updated')
    expect(new RecordedAudioState(db).getMapping('rec-1', SHA_A)).toEqual(confirmedMapping)
    db.close()
  })

  it('accepts whitespace, key order and source map order only after a fresh attestation', () => {
    const { db, owner, service, first } = associated()
    const value = JSON.parse(first)
    const variants = [
      JSON.stringify(value, null, 2),
      JSON.stringify(reverseKeys(value)),
      JSON.stringify({ ...value, audio: { ...value.audio, sourceMap: [...value.audio.sourceMap].reverse() } })
    ]
    variants.forEach((payload, index) => {
      expect(payload).not.toBe(first)
      expect(service.updatePresentationMetadata(argsFor(payload))).toEqual({ status: 'updated', change: 'serialization' })
      expect(owner.requests).toHaveLength(index + 1)
      expect(owner.requests[index].manifestSha256).toBe(manifestSha(payload))
      expect(service.get('rec-1', SHA_A)).toMatchObject({
        manifestSha256: manifestSha(payload),
        sourceMap: [
          { channelIndex: 0, role: 'microphone' },
          { channelIndex: 1, role: 'system' }
        ]
      })
    })
    expect(service.getRevisions('rec-1', SHA_A).map((r) => r.revision)).toEqual([1, 2, 3, 4])
    db.close()
  })

  it('asks for a fresh attestation even when the same payload is sent again', () => {
    const { db, owner, service, first } = associated()
    expect(service.updatePresentationMetadata(argsFor(first))).toEqual({ status: 'unchanged' })
    expect(owner.requests).toHaveLength(1)
    owner.attest = () => null
    expect(service.updatePresentationMetadata(argsFor(first))).toMatchObject({ status: 'rejected', code: 'origin-unverified' })
    expect(service.getRevisions('rec-1', SHA_A)).toHaveLength(1)
    db.close()
  })

  it('rejects an unattested, mis-attested or unavailable update and keeps the stored manifest', () => {
    const { db, owner, service, first } = associated()
    const before = JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))
    const next = renamed()
    const honest = owner.attest
    owner.attest = () => null
    expect(service.updatePresentationMetadata(argsFor(next))).toMatchObject({ code: 'origin-unverified' })
    owner.attest = (request) => ({ ...honest(request)!, manifestSha256: manifestSha(first) })
    expect(service.updatePresentationMetadata(argsFor(next))).toMatchObject({ code: 'origin-unverified' })
    owner.attest = (request) => ({ ...honest(request)!, evidenceId: ' ' })
    expect(service.updatePresentationMetadata(argsFor(next))).toMatchObject({ code: 'origin-unverified' })
    owner.attest = () => {
      throw new Error('boom')
    }
    expect(service.updatePresentationMetadata(argsFor(next))).toMatchObject({ code: 'origin-unverified' })
    owner.attest = honest
    owner.capability = false
    expect(service.updatePresentationMetadata(argsFor(next))).toEqual({ status: 'unavailable', code: 'capability-unavailable' })
    owner.capability = true
    expect(service.updatePresentationMetadata({ ...argsFor(next), manifestPayload: null })).toEqual({
      status: 'unavailable',
      code: 'manifest-absent'
    })
    expect(JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))).toBe(before)
    expect(service.getRevisions('rec-1', SHA_A)).toHaveLength(1)
    db.close()
  })

  it('rejects role, clock and marker changes without merging anything', () => {
    const { db, owner, service } = associated()
    const before = JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))
    const base = manifestFor(SHA_A, fileNamed('renamed.wav'))
    const mapping = JSON.stringify(new RecordedAudioState(db).getMapping('rec-1', SHA_A))
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['role swap', { audio: { ...base.audio, sourceMap: [{ channelIndex: 0, role: 'system' }, { channelIndex: 1, role: 'microphone' }] } }, 'source-map'],
      ['role to unknown', { audio: { ...base.audio, sourceMap: [{ channelIndex: 0, role: 'unknown' }, { channelIndex: 1, role: 'system' }] } }, 'source-map'],
      ['clock removed', { audio: { ...base.audio, clock: null } }, 'clock'],
      ['marker moved', { markers: [{ markerId: null, type: 'unknown', position: { unit: 'legacy-ms', value: 1600 } }] }, 'markers'],
      ['marker added', { markers: [...base.markers, { markerId: 'm1', type: 'manual', position: { unit: 'capture-frame', value: 100 } }] }, 'markers'],
      ['marker removed', { markers: [] }, 'markers'],
      ['marker label added', { markers: [{ ...base.markers[0], label: 'intro' }] }, 'markers'],
      ['bitrate-free audio field', { audio: { ...base.audio, bitsPerSample: undefined } }, 'binding']
    ]
    for (const [label, change, section] of cases) {
      const result = service.updatePresentationMetadata(argsFor(JSON.stringify({ ...base, ...change })))
      expect(result.status, label).toBe('rejected')
      if (section !== 'binding') expect(result, label).toMatchObject({ code: 'metadata-conflict', detail: expect.stringContaining(section) })
    }
    expect(JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))).toBe(before)
    expect(JSON.stringify(new RecordedAudioState(db).getMapping('rec-1', SHA_A))).toBe(mapping)
    expect(service.getRevisions('rec-1', SHA_A)).toHaveLength(1)
    expect(owner.requests).toHaveLength(0)
    db.close()
  })

  it('rejects another device id, generation, source or recording', () => {
    const { db, owner, service } = associated()
    const before = JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))
    expect(service.updatePresentationMetadata(argsFor(JSON.stringify(manifestFor(SHA_A, { ...fileNamed('a.wav'), contentGeneration: 'gen-2' }))))).toMatchObject({
      code: 'identity-conflict'
    })
    expect(service.updatePresentationMetadata(argsFor(JSON.stringify(manifestFor(SHA_A, { ...fileNamed('a.wav'), recordingId: 'DEVICE-REC-1' }))))).toMatchObject({
      code: 'identity-conflict'
    })
    expect(service.updatePresentationMetadata(argsFor(renamed(), 'rec-2'))).toMatchObject({ code: 'association-missing' })
    const otherSource = JSON.stringify(manifestFor(SHA_B, { file: { name: 'a.wav', byteLength: BYTE_LENGTH, sha256: SHA_B } }))
    expect(service.updatePresentationMetadata(argsFor(otherSource, 'rec-1', SHA_B))).toMatchObject({ code: 'association-missing' })
    expect(service.updatePresentationMetadata({ ...argsFor(renamed()), measured: { ...argsFor(renamed()).measured, layout: layoutFor(SHA_B) } })).toMatchObject({
      code: 'binding-mismatch'
    })
    expect(service.updatePresentationMetadata(argsFor(renamed(), 'rec-missing'))).toMatchObject({ code: 'recording-not-found' })
    expect(service.updatePresentationMetadata(argsFor(JSON.stringify({ ...manifestFor(SHA_A, fileNamed('a.wav')), state: 'open', file: { name: 'a.wav', byteLength: 0 } })))).toMatchObject({
      code: 'open-recording'
    })
    expect(service.updatePresentationMetadata(argsFor('{nope'))).toMatchObject({ code: 'manifest-invalid' })
    expect(JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))).toBe(before)
    expect(owner.requests).toHaveLength(0)
    db.close()
  })

  it('rejects with layout-conflict when the stored layout differs from the valid original measurement', () => {
    const { db, owner, service } = associated()
    new RecordedAudioState(db).saveLayout('rec-1', { ...layoutFor(SHA_A), durationSeconds: 14 })
    const before = JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))
    expect(service.updatePresentationMetadata(argsFor(renamed()))).toMatchObject({ status: 'rejected', code: 'layout-conflict' })
    expect(JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))).toBe(before)
    expect(service.getRevisions('rec-1', SHA_A)).toHaveLength(1)
    expect(owner.requests).toHaveLength(0)
    db.close()
  })

  it('rolls everything back when persistence fails part-way', () => {
    for (const pattern of [/UPDATE recording_manifest_associations/, /INSERT INTO recording_manifest_association_history/]) {
      const { db, owner, first } = associated()
      const failing: Pick<Database, 'run' | 'exec'> = {
        exec: (sql: string, params?: never) => db.exec(sql, params),
        run: ((sql: string, params?: never) => {
          if (pattern.test(sql) && owner.requests.length > 0) throw new Error('disk full')
          return db.run(sql, params)
        }) as Database['run']
      }
      const service = serviceFor(failing, owner)
      const before = JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))
      const result = service.updatePresentationMetadata(argsFor(renamed()))
      expect(result, String(pattern)).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect(JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))).toBe(before)
      expect(service.getRevisions('rec-1', SHA_A).map((r) => r.rawManifest)).toEqual([first])
      owner.requests.length = 0
      expect(serviceFor(db, owner).updatePresentationMetadata(argsFor(renamed())).status).toBe('updated')
      db.close()
    }
  })

  describe('savepoint failures', () => {
    const opening = { match: /^\s*SAVEPOINT/, message: 'cannot start savepoint' }
    const releasing = { match: /^\s*RELEASE/, message: 'release boom' }
    const rollingBack = { match: /^\s*ROLLBACK TO/, message: 'rollback boom' }
    const historyInsert = { match: /INSERT INTO recording_manifest_association_history/, message: 'disk full' }
    const rowsOf = (db: Database) => JSON.stringify(db.exec('SELECT * FROM recording_manifest_associations'))
    function faulty(db: Database, rules: Array<{ match: RegExp; message: string }>) {
      const control = { armed: false, statements: [] as string[] }
      const wrapper: Pick<Database, 'run' | 'exec'> = {
        exec: (sql: string, params?: never) => db.exec(sql, params),
        run: ((sql: string, params?: never) => {
          if (control.armed) {
            control.statements.push(sql.trim())
            const rule = rules.find((r) => r.match.test(sql))
            if (rule) throw new Error(rule.message)
          }
          return db.run(sql, params)
        }) as Database['run']
      }
      return { wrapper, control }
    }
    const attempted = (statements: string[], word: string) => statements.some((s) => s.startsWith(word))

    it('reports storage-failed when the association savepoint cannot be opened', () => {
      const db = newDb()
      const { wrapper, control } = faulty(db, [opening])
      control.armed = true
      const result = serviceFor(wrapper, evidenceOwner()).associate(input().args)
      expect(result).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect((result as { detail: string }).detail).toContain('cannot start savepoint')
      expect((result as { detail: string }).detail).toContain('savepoint not opened')
      expect(attempted(control.statements, 'ROLLBACK')).toBe(false)
      expect(attempted(control.statements, 'RELEASE')).toBe(false)
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      expect(count(db, 'recording_audio_layouts')).toBe(0)
      control.armed = false
      expect(serviceFor(wrapper, evidenceOwner()).associate(input().args).status).toBe('associated')
      db.close()
    })

    it('reports storage-failed when the update savepoint cannot be opened and changes nothing', () => {
      const { db, owner } = associated()
      const before = rowsOf(db)
      const { wrapper, control } = faulty(db, [opening])
      control.armed = true
      const result = serviceFor(wrapper, owner).updatePresentationMetadata(argsFor(renamed()))
      expect(result).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect((result as { detail: string }).detail).toContain('savepoint not opened')
      expect(attempted(control.statements, 'ROLLBACK')).toBe(false)
      expect(rowsOf(db)).toBe(before)
      expect(serviceFor(db, owner).getRevisions('rec-1', SHA_A)).toHaveLength(1)
      control.armed = false
      expect(serviceFor(wrapper, owner).updatePresentationMetadata(argsFor(renamed())).status).toBe('updated')
      db.close()
    })

    it('rolls the association back when RELEASE fails and keeps the original error', () => {
      const db = newDb()
      const durableBytes = db.export()
      const owner = evidenceOwner()
      const { wrapper, control } = faulty(db, [releasing])
      control.armed = true
      const service = serviceFor(wrapper, owner)
      const result = service.associate(input().args)
      expect(result).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect((result as { detail: string }).detail).toContain('release boom')
      expect((result as { detail: string }).detail).toContain('release failed: release boom; savepoint left open')
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      expect(count(db, 'recording_audio_layouts')).toBe(0)
      control.armed = false
      db.run('ROLLBACK TO recording_manifest_association')
      db.run('RELEASE recording_manifest_association')
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      const sameConnectionService = serviceFor(wrapper, owner)
      expect(sameConnectionService.associate(input().args)).toMatchObject({
        status: 'rejected', code: 'storage-failed', detail: expect.stringContaining('reopen a fresh connection')
      })
      expect(owner.requests).toHaveLength(1)
      expect(() => sameConnectionService.get('rec-1', SHA_A)).toThrow(/recovery.*reopen/i)
      db.close()

      const reopened = new SQL.Database(durableBytes)
      const reopenedOwner = evidenceOwner()
      const reopenedService = serviceFor(reopened, reopenedOwner)
      expect(reopenedService.get('rec-1', SHA_A)).toBeNull()
      expect(reopened.exec('SELECT value FROM old_data')[0].values).toEqual([['keep']])
      expect(reopenedService.associate(input().args).status).toBe('associated')
      expect(reopenedService.get('rec-1', SHA_A)?.manifest.file.name).toBe(manifestFor(SHA_A).file.name)
      reopened.close()
    })

    it('rolls the update back when RELEASE fails and keeps the original error', () => {
      const { db, owner } = associated()
      const durableBytes = db.export()
      const before = rowsOf(db)
      const { wrapper, control } = faulty(db, [releasing])
      control.armed = true
      const service = serviceFor(wrapper, owner)
      const result = service.updatePresentationMetadata(argsFor(renamed()))
      expect(result).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect((result as { detail: string }).detail).toContain('release boom')
      expect((result as { detail: string }).detail).toContain('release failed: release boom; savepoint left open')
      expect(rowsOf(db)).toBe(before)
      control.armed = false
      db.run('ROLLBACK TO recording_manifest_association')
      db.run('RELEASE recording_manifest_association')
      expect(rowsOf(db)).toBe(before)
      expect(() => service.get('rec-1', SHA_A)).toThrow(/recovery.*reopen/i)
      expect(serviceFor(wrapper, owner).updatePresentationMetadata(argsFor(renamed()))).toMatchObject({
        status: 'rejected', code: 'storage-failed'
      })
      expect(owner.requests).toHaveLength(1)
      db.close()

      const reopened = new SQL.Database(durableBytes)
      const reopenedOwner = evidenceOwner()
      const reopenedService = serviceFor(reopened, reopenedOwner)
      expect(reopenedService.get('rec-1', SHA_A)?.manifest.file.name).toBe('2026Oct09-130550-Rec76.wav')
      expect(reopenedService.getRevisions('rec-1', SHA_A)).toHaveLength(1)
      expect(reopenedService.updatePresentationMetadata(argsFor(renamed()))).toEqual({
        status: 'updated', change: 'file-name'
      })
      expect(reopenedService.get('rec-1', SHA_A)?.manifest.file.name).toBe('renamed.wav')
      reopened.close()
    })

    it('keeps the work error and leaves the savepoint open when the association rollback fails', () => {
      const db = newDb()
      const durableBytes = db.export()
      const owner = evidenceOwner()
      const { wrapper, control } = faulty(db, [historyInsert, rollingBack])
      control.armed = true
      const service = serviceFor(wrapper, owner)
      const result = service.associate(input().args)
      expect(result).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      const detail = (result as { detail: string }).detail
      expect(detail).toContain('disk full')
      expect(detail).toContain('rollback failed: rollback boom')
      expect(detail).toContain('savepoint left open')
      expect(attempted(control.statements, 'RELEASE')).toBe(false)
      expect(count(db, 'recording_manifest_associations')).toBe(1)
      expect(() => service.get('rec-1', SHA_A)).toThrow(/recovery.*reopen/i)
      expect(() => service.getRevisions('rec-1', SHA_A)).toThrow(/recovery.*reopen/i)
      const partialRows = rowsOf(db)
      const sameConnectionService = serviceFor(wrapper, owner)
      expect(sameConnectionService.associate(input().args)).toMatchObject({
        status: 'rejected', code: 'storage-failed', detail: expect.stringContaining('reopen a fresh connection')
      })
      expect(sameConnectionService.updatePresentationMetadata(argsFor(renamed()))).toMatchObject({
        status: 'rejected', code: 'storage-failed', detail: expect.stringContaining('reopen a fresh connection')
      })
      expect(rowsOf(db)).toBe(partialRows)
      expect(owner.requests).toHaveLength(1)
      control.armed = false
      db.run('ROLLBACK TO recording_manifest_association')
      db.run('RELEASE recording_manifest_association')
      expect(tableNames(db)).not.toContain('recording_manifest_associations')
      expect(count(db, 'recording_audio_layouts')).toBe(0)
      expect(sameConnectionService.associate(input().args)).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect(sameConnectionService.updatePresentationMetadata(argsFor(renamed()))).toMatchObject({
        status: 'rejected', code: 'storage-failed'
      })
      expect(() => sameConnectionService.get('rec-1', SHA_A)).toThrow(/recovery.*reopen/i)
      expect(owner.requests).toHaveLength(1)
      db.close()

      const reopened = new SQL.Database(durableBytes)
      const reopenedOwner = evidenceOwner()
      const reopenedService = serviceFor(reopened, reopenedOwner)
      expect(reopenedService.get('rec-1', SHA_A)).toBeNull()
      expect(reopened.exec('SELECT value FROM old_data')[0].values).toEqual([['keep']])
      expect(reopenedService.associate(input().args).status).toBe('associated')
      reopened.close()
    })

    it('keeps the work error and leaves the savepoint open when the update rollback fails', () => {
      const { db, owner } = associated()
      const durableBytes = db.export()
      const before = rowsOf(db)
      const { wrapper, control } = faulty(db, [historyInsert, rollingBack])
      control.armed = true
      const service = serviceFor(wrapper, owner)
      const result = service.updatePresentationMetadata(argsFor(renamed()))
      expect(result).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      const detail = (result as { detail: string }).detail
      expect(detail).toContain('disk full')
      expect(detail).toContain('rollback failed: rollback boom')
      expect(detail).toContain('savepoint left open')
      expect(attempted(control.statements, 'RELEASE')).toBe(false)
      expect(rowsOf(db)).not.toBe(before)
      expect(() => service.get('rec-1', SHA_A)).toThrow(/recovery.*reopen/i)
      expect(() => service.getRevisions('rec-1', SHA_A)).toThrow(/recovery.*reopen/i)
      const sameConnectionService = serviceFor(wrapper, owner)
      expect(sameConnectionService.associate(input().args)).toMatchObject({ status: 'rejected', code: 'storage-failed' })
      expect(sameConnectionService.updatePresentationMetadata(argsFor(renamed()))).toMatchObject({
        status: 'rejected', code: 'storage-failed'
      })
      expect(owner.requests).toHaveLength(1)
      control.armed = false
      db.run('ROLLBACK TO recording_manifest_association')
      db.run('RELEASE recording_manifest_association')
      expect(rowsOf(db)).toBe(before)
      expect(() => sameConnectionService.get('rec-1', SHA_A)).toThrow(/recovery.*reopen/i)
      expect(sameConnectionService.updatePresentationMetadata(argsFor(renamed()))).toMatchObject({
        status: 'rejected', code: 'storage-failed'
      })
      expect(owner.requests).toHaveLength(1)
      db.close()

      const reopened = new SQL.Database(durableBytes)
      const reopenedOwner = evidenceOwner()
      const reopenedService = serviceFor(reopened, reopenedOwner)
      expect(reopenedService.get('rec-1', SHA_A)?.manifest.file.name).toBe('2026Oct09-130550-Rec76.wav')
      expect(reopenedService.getRevisions('rec-1', SHA_A)).toHaveLength(1)
      expect(reopenedService.updatePresentationMetadata(argsFor(renamed())).status).toBe('updated')
      reopened.close()
    })
  })

  it('upgrades a row written before the history table existed without losing it', () => {
    const { db, service, first } = associated()
    db.run('DROP TABLE recording_manifest_association_history')
    expect(service.getRevisions('rec-1', SHA_A)).toEqual([])
    const next = renamed()
    expect(service.updatePresentationMetadata(argsFor(next))).toEqual({ status: 'updated', change: 'file-name' })
    const revisions = service.getRevisions('rec-1', SHA_A)
    expect(revisions.map((r) => [r.revision, r.fileName, r.rawManifest])).toEqual([
      [1, '2026Oct09-130550-Rec76.wav', null],
      [2, 'renamed.wav', next]
    ])
    expect(revisions[0].manifestSha256).toBe(manifestSha(first))
    db.close()
  })
})
