/** Isolated local profile/library for real app publication tests. Original profile is read only. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
const original = join(process.env.APPDATA, 'hidock-universal-knowledge-hub')
const bytes = await readFile(join(original, 'config.json'))
const config = JSON.parse(bytes)
const profile = resolve('node_modules/.cache/completion630-runtime', `profile-${Date.now()}`)
const dataPath = join(profile, 'library')
const database = join(dataPath, 'data', 'hidock.db')
await mkdir(join(dataPath, 'data'), { recursive: true })
const originalDatabase = join(config.storage?.dataPath || original, 'data', 'hidock.db')
const source = new Database(originalDatabase, { readonly: true, fileMustExist: true })
try { await source.backup(database) } finally { source.close() }
config.storage = { ...config.storage, dataPath, recordingsPath: join(dataPath, 'recordings'), transcriptsPath: join(dataPath, 'transcripts') }
config.device = { ...config.device, autoConnect: false, autoDownload: false }
await writeFile(join(profile, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
await writeFile(resolve('node_modules/.cache/completion630-runtime/isolated-profile.private.json'), JSON.stringify({profile,dataPath,originalConfigSha256:createHash('sha256').update(bytes).digest('hex')},null,2))
console.log(JSON.stringify({prepared:true,sourceOpenedReadOnly:true,sqliteBackupBytes:(await stat(database)).size,originalConfigChanged:false}))
