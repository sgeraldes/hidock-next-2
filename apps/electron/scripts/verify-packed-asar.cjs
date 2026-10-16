'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { Script } = require('node:vm')
const asar = require('@electron/asar')

// Read the actual payload, not source files or stale asar module cache.
function verifyPackedAsar(archive) {
  asar.uncache(archive)
  const { header, headerSize } = asar.getRawHeader(archive)
  const fd = fs.openSync(archive, 'r')
  let verified = 0
  try {
    const archiveSize = fs.fstatSync(fd).size
    const buffer = Buffer.alloc(1024 * 1024)
    function visit(directory, prefix = '') {
      for (const [name, entry] of Object.entries(directory.files || {})) {
        const filename = prefix ? `${prefix}/${name}` : name
        if (entry.files) { visit(entry, filename); continue }
        if (entry.link || entry.unpacked) continue
        const offset = Number(entry.offset)
        const start = 8 + headerSize + offset
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
            !Number.isSafeInteger(start + entry.size) || start + entry.size > archiveSize) {
          throw Error(`Invalid packed ASAR size/offset: ${filename}`)
        }
        if (entry.integrity?.algorithm !== 'SHA256' || !/^[a-f0-9]{64}$/i.test(entry.integrity.hash || '')) {
          throw Error(`Missing packed ASAR SHA256: ${filename}`)
        }
        const hash = createHash('sha256')
        let read = 0
        while (read < entry.size) {
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, entry.size - read), start + read)
          if (!count) throw Error(`Truncated packed ASAR entry: ${filename}`)
          hash.update(buffer.subarray(0, count))
          read += count
        }
        if (hash.digest('hex') !== entry.integrity.hash.toLowerCase()) {
          throw Error(`Packed ASAR integrity mismatch: ${filename}`)
        }
        verified++
      }
    }
    visit(header)
    const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
    if (typeof manifest.main !== 'string' || !manifest.main || path.isAbsolute(manifest.main)) {
      throw Error('Packed package.json has no safe main entry')
    }
    const main = path.normalize(manifest.main)
    if (main === '..' || main.startsWith(`..${path.sep}`)) throw Error('Packed main escapes archive')
    const entry = asar.statFile(archive, main)
    if (entry.files || entry.unpacked) throw Error('Packed main must be an archived JavaScript file')
    new Script(asar.extractFile(archive, main).toString('utf8'), { filename: main })
    return { verified, main }
  } finally { fs.closeSync(fd) }
}
module.exports = { verifyPackedAsar }
