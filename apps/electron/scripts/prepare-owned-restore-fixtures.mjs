/** Create only synthetic fixtures in the existing isolated validation library. */
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
const root = resolve('node_modules/.cache/completion630-runtime')
const config = JSON.parse(await readFile(join(root, 'isolated-profile.private.json'), 'utf8'))
const dataPath = resolve(config.dataPath), profile = resolve(config.profile)
if (![dataPath, profile].every(value => value.startsWith(root + sep))) throw Error('Only the contained validation library is supported')
const directory = join(dataPath, 'recordings')
if (!(await lstat(directory)).isDirectory() || !(await realpath(directory)).toLowerCase().startsWith((await realpath(dataPath)).toLowerCase() + sep)) throw Error('Contained regular recording storage required')
const database = new Database(join(dataPath, 'data', 'hidock.db'), { fileMustExist: true })
const fixtures = []
try {
  for (const [label, payload] of [['small', 512], ['large', 9 * 1024 * 1024]]) {
    const id = randomUUID(), original = `audit${id.slice(0, 8)}${label[0]}.wav`, filename = `restore-source-${id}.wav`, target = join(directory, filename)
    const bytes = Buffer.alloc(44 + payload)
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
    bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(64000, 28)
    bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(payload, 40)
    for (let frame = 0; frame < payload / 4; frame++) {
      bytes.writeInt16LE(Math.round(400 * Math.sin(2 * Math.PI * 440 * frame / 16000)), 44 + frame * 4)
      bytes.writeInt16LE(Math.round(200 * Math.sin(2 * Math.PI * 1000 * frame / 16000)), 46 + frame * 4)
    }
    await writeFile(target, bytes, { flag: 'wx' })
    database.prepare("INSERT INTO recordings(id,filename,original_filename,file_path,file_size,duration_seconds,date_recorded,location,on_local,on_device,source,is_imported,transcription_status) VALUES(?,?,?,?,?,?,?,'local-only',1,0,'device',1,'none')")
      .run(id, filename, original, target, bytes.length, payload / 64000, new Date().toISOString())
    fixtures.push({ label, recordingId: id, originalFilename: original, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), synthetic: true })
  }
} finally { database.close() }
const ledger = join(root, `restore-fixtures-${Date.now()}.private.json`)
await writeFile(ledger, JSON.stringify({ createdAt: new Date().toISOString(), hardwareCalls: 0, productionProfileUsed: false, fixtures }, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ ledger, fixtures: fixtures.map(({ label, bytes, sha256 }) => ({ label, bytes, sha256 })), hardwareCalls: 0, productionProfileUsed: false }, null, 2))
