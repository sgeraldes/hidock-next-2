// Bounded by the Windows job used by guarded-process.ps1; never run standalone.
const { spawn } = require('node:child_process')
if (!process.argv.includes('--guard-test')) throw new Error('Requires guarded test launch')
if (!process.argv.includes('child')) spawn(process.execPath, [__filename, '--guard-test', 'child'], { stdio: 'ignore' })
const held = []
setInterval(() => {
  try { held.push(Buffer.alloc(12 * 1024 * 1024, 1)) }
  catch { process.exit(0) }
}, 200)
setTimeout(() => process.exit(0), 8000)
