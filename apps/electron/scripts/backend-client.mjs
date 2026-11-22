import { readFileSync } from 'node:fs'
const [lockPath, command, ...args] = process.argv.slice(2)
if (!lockPath || !command) throw new Error('Usage: node scripts/backend-client.mjs <brain.json> status|inventory|jobs|submit|cancel|ui|stop [arguments]')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
if (!Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535 || typeof lock.token !== 'string' || !lock.token || typeof lock.instanceId !== 'string') throw new Error('Invalid backend discovery file')
async function call(path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${lock.port}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${lock.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  if (!response.ok) throw new Error(`Backend HTTP ${response.status}: ${result.error ?? 'request rejected'}`)
  return result
}
const health = await call('/health')
if (health.instanceId !== lock.instanceId || health.pid !== lock.pid) throw new Error('Backend identity does not match discovery file')
let result
switch (command) {
  case 'status': result = await call('/backend/status'); break
  case 'inventory': {
    const [since, until, limit = '50'] = args
    if (!since || !until) throw new Error('inventory requires explicit since and until ISO timestamps with timezone')
    result = await call(`/recordings?${new URLSearchParams({ since, until, limit })}`); break
  }
  case 'jobs': if (!args[0]) throw new Error('jobs requires comma-separated recording IDs'); result = await call(`/transcriptions?${new URLSearchParams({ ids: args[0] })}`); break
  case 'submit': {
    const [requestId, provider, ids] = args
    if (!requestId || !provider || !ids) throw new Error('submit requires requestId, provider and comma-separated recording IDs')
    result = await call('/transcriptions', 'POST', { requestId, provider, recordingIds: ids.split(',') }); break
  }
  case 'cancel': if (!args[0]) throw new Error('cancel requires one recording ID'); result = await call(`/transcriptions/${encodeURIComponent(args[0])}/cancel`, 'POST'); break
  case 'ui': result = await call('/backend/ui', 'POST'); break
  case 'stop': result = await call('/backend/stop', 'POST'); break
  default: throw new Error('Unknown fixed operation')
}
console.log(JSON.stringify(result, null, 2))
