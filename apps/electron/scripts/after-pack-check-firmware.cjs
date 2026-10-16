'use strict'
// Preserve the existing packed-Electron native-binding check, then read back
// the actual image shipped beside that executable. Neither check opens USB.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { ACCEPTED_H1E_FIRMWARE, ACCEPTED_H1E_FORWARD_STOCK_RESTORE, parseFirmwareImage } = require('../../../packages/jensen-protocol/dist/index.cjs')
const nativeCheck = require('./after-pack-check-native.cjs').default
const { verifyPackedAsar } = require('./verify-packed-asar.cjs')
exports.default = async context => {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const header = require('@electron/asar').getRawHeader(join(resources, 'app.asar')).header
  const fileCount = entry => entry?.files ? Object.values(entry.files).reduce((sum, child) => sum + fileCount(child), 0) : entry ? 1 : 0
  const hasPrivateKey = entry => Boolean(entry?.files && Object.entries(entry.files).some(([name, child]) => name === '.security-key' || hasPrivateKey(child)))
  if (fileCount(header.files.logs) || fileCount(header.files['.diagnostics']) || fileCount(header.files.node_modules?.files?.['.cache']) || hasPrivateKey(header)) throw Error('Runtime logs, private key or workspace diagnostics/cache entered the application package')
  console.log('  • confidentiality check: no runtime logs, private key or workspace diagnostics/cache in ASAR')
  const integrity = verifyPackedAsar(join(resources, 'app.asar'))
  console.log(`  • ASAR integrity: ${integrity.verified} packed files verified; ${integrity.main} parsed`)
  await nativeCheck(context)
  const bytes = new Uint8Array(readFileSync(join(resources, 'firmware', 'h1e-rea-hardened.bin')))
  const sha256 = createHash('sha256').update(bytes).digest('hex'), metadata = parseFirmwareImage(bytes)
  if (sha256 !== ACCEPTED_H1E_FIRMWARE.sha256 || bytes.length !== ACCEPTED_H1E_FIRMWARE.bytes || metadata?.versionNumber !== ACCEPTED_H1E_FIRMWARE.versionNumber || metadata.versionName !== '6.3.4_restore001') throw Error('Packed firmware resource does not match the exact qualified image')
  console.log(`  • firmware check: actual packed resource ${sha256}, ${bytes.length} bytes; installation unverified`)
  const forward = new Uint8Array(readFileSync(join(resources, 'firmware', 'h1e-stock-forward.bin')))
  const forwardMetadata = parseFirmwareImage(forward)
  if (createHash('sha256').update(forward).digest('hex') !== ACCEPTED_H1E_FORWARD_STOCK_RESTORE.sha256 || forward.length !== ACCEPTED_H1E_FORWARD_STOCK_RESTORE.bytes ||
    forwardMetadata?.versionNumber !== ACCEPTED_H1E_FORWARD_STOCK_RESTORE.versionNumber || forwardMetadata.versionName !== '6.3.5_reaRestore2') throw Error('Packed forward stock resource failed exact pin or container checks')
  console.log('  • forward stock check: exact pinned container shipped; physical restoration unverified')
  const archName = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch]
  if (context.electronPlatformName === process.platform && archName === process.arch) {
    const name = context.packager.appInfo.productFilename
    const exe = context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
      : join(context.appOutDir, context.electronPlatformName === 'win32' ? `${name}.exe` : name)
    // Native USB and its loader are shipped unpacked. Run the real production
    // files directly; Electron-as-Node cannot resolve archive package metadata.
    const modulePath = join(resources, 'app.asar.unpacked', 'node_modules', 'usb')
    execFileSync(exe, ['-e', 'const u=require(process.argv[1]);if(typeof u.WebUSB!=="function"||!u.usb)throw Error("Packed USB backend unavailable")', modulePath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 10000,
    })
    console.log('  • USB check: packed Electron loaded its actual USB backend/dependencies; no device opened')
  }
}
