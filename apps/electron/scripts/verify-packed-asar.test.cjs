const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')
const { verifyPackedAsar } = require('./verify-packed-asar.cjs')

async function fixture(callback, main = 'module.exports = 42', manifest = '{"main":"main.js"}') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hidock-asar-test-'))
  try {
    const source = path.join(root, 'source'), archive = path.join(root, 'app.asar')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'package.json'), manifest)
    fs.writeFileSync(path.join(source, 'main.js'), main)
    await asar.createPackage(source, archive)
    await callback(archive)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
test('verifies actual package payload and parses main without executing it', async () => {
  await fixture(archive => assert.equal(verifyPackedAsar(archive).verified, 2), 'throw Error("must not execute")')
})
test('rejects payload corruption and truncated archives', async () => {
  await fixture(archive => {
    const { headerSize } = asar.getRawHeader(archive)
    const entry = asar.statFile(archive, 'main.js'), fd = fs.openSync(archive, 'r+')
    fs.writeSync(fd, Buffer.from('!'), 0, 1, 8 + headerSize + Number(entry.offset))
    fs.closeSync(fd)
    assert.throws(() => verifyPackedAsar(archive), /integrity mismatch/)
  })
  await fixture(archive => {
    fs.truncateSync(archive, fs.statSync(archive).size - 1)
    assert.throws(() => verifyPackedAsar(archive), /size\/offset/)
  })
})
test('rejects malformed manifest, missing entry and invalid JavaScript despite matching hashes', async () => {
  await fixture(archive => assert.throws(() => verifyPackedAsar(archive)), '42', '{')
  await fixture(archive => assert.throws(() => verifyPackedAsar(archive)), '42', '{"main":"missing.js"}')
  await fixture(archive => assert.throws(() => verifyPackedAsar(archive), SyntaxError), 'function {')
})
