import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseFirmwareImage } from '../../../packages/jensen-protocol/dist/index.js'
const base = path.resolve('../../research/rea/completion630-lab/firmware/restore-build393988')
const sha = data => createHash('sha256').update(data).digest('hex')
const json = name => JSON.parse(fs.readFileSync(path.join(base, name)))
const handoff = json('final-handoff-verification.json')
const snapshot = json(handoff.snapshot), qualification = json(handoff.qualification)
const snapshotDir = path.dirname(path.join(base, handoff.snapshot))
if (sha(fs.readFileSync(path.join(base, handoff.snapshot))) !== handoff.snapshotSha256 || sha(fs.readFileSync(path.join(base, handoff.qualification))) !== handoff.qualificationSha256) throw Error('Frozen index digest mismatch')
for (const entry of snapshot.files) {
  const filename = path.resolve(snapshotDir, entry.path)
  if (!filename.startsWith(snapshotDir + path.sep)) throw Error('Snapshot boundary mismatch')
  const data = fs.readFileSync(filename)
  if (data.length !== entry.bytes || sha(data) !== entry.sha256) throw Error('Frozen source mismatch: ' + entry.path)
}
for (const [filename, digest] of Object.entries(qualification.evidence)) {
  if (sha(fs.readFileSync(path.join(snapshotDir, filename))) !== digest) throw Error('Qualification mismatch: ' + filename)
}
const images = [handoff.candidateManifest, handoff.forwardManifest].map(name => {
  const manifest = json(name), data = fs.readFileSync(path.join(base, path.dirname(name), manifest.artifact)), metadata = parseFirmwareImage(data)
  if (data.length !== manifest.bytes || sha(data) !== manifest.sha256 || metadata?.versionNumber !== manifest.packed_version || metadata.versionName !== manifest.version_name) throw Error('Firmware container identity/digest mismatch')
  return { bytes: data.length, sha256: sha(data), ...metadata }
})
console.log(JSON.stringify({ observedAt: new Date().toISOString(), boundary: 'root-independent-frozen-hash-and-generic-container-parser', snapshotFiles: snapshot.files.length, qualificationFiles: Object.keys(qualification.evidence).length, images, hardwareCommands: 0, passed: true }, null, 2))
