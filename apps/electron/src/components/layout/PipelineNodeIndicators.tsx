import { useEffect, useState } from 'react'
import { Activity, ChevronDown, Cpu, HardDrive, MemoryStick, Monitor, Server, TriangleAlert, WifiOff } from 'lucide-react'
import type { PipelineTelemetry } from '@/shared/pipeline-telemetry'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

type Density = 'expanded' | 'compact' | 'icons'
type Scope = 'app' | 'system'
type Units = 'gb' | 'percent'
type Metric = { label: string; value: number | null; percent: number | null; memory?: boolean }
const palette = { unknown: '#5B6472', idle: '#F8FAFC', active: '#009FE8', medium: '#FFC400', high: '#F04438' }
export function metricColor(percent: number | null, active: boolean) {
  return percent === null ? palette.unknown : percent >= 80 ? palette.high
    : percent >= 50 ? palette.medium : active ? palette.active : palette.idle
}
const valid = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
const ratio = (used: number | null, total: number | null) =>
  used !== null && total !== null && total > 0 ? Math.min(100, used / total * 100) : null
const fresh = (date: string | null | undefined, now: number) => {
  const age = now - Date.parse(date || '')
  return Number.isFinite(age) && age >= -5000 && age < 45000
}
function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = localStorage.getItem(key) as T; return allowed.includes(value) ? value : fallback }
  catch { return fallback }
}
function usePreference<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => stored(key, allowed, fallback))
  return [value, (next: T) => { setValue(next); try { localStorage.setItem(key, next) } catch { /* optional */ } }] as const
}

function remoteNodeState(state: string | null | undefined, activeJobs: number, available: boolean) {
  if (!available) return { active: false, warning: false, status: 'Unavailable or stale' }
  const normalized = state?.trim().toLowerCase() || null
  switch (normalized) {
    case 'ready': {
      const active = activeJobs > 0
      return { active, warning: false, status: active ? 'Working' : 'Idle' }
    }
    case 'busy': return { active: true, warning: false, status: 'Working' }
    case 'paused': return { active: false, warning: true, status: 'Paused' }
    case 'stopped': return { active: false, warning: true, status: 'Stopped' }
    default: return { active: false, warning: true, status: normalized ? `Unknown state (${normalized})` : 'State unknown' }
  }
}

export function nodeReadings(snapshot: PipelineTelemetry | null, scope: Scope, unavailable: boolean, now: number) {
  const client = snapshot?.client
  const host = snapshot?.host.telemetry
  const localFresh = !unavailable && fresh(snapshot?.sampledAt, now)
  const remoteFresh = localFresh && !!snapshot?.host.reachable && fresh(host?.sampledAt, now)
  const gpuFresh = remoteFresh && fresh(host?.gpuSampledAt, now)
  const localRam = localFresh && client ? valid(scope === 'app' ? client.ramMiB : client.totalRamMiB - client.freeRamMiB) : null
  const remoteRam = remoteFresh && host ? valid(scope === 'app' ? host.serviceRssMiB : host.memoryUsedMiB) : null
  const localCpu = localFresh && client ? valid(scope === 'app' ? client.cpuPartial ? null : client.cpuPercent : client.systemCpuPercent) : null
  const remoteCpu = remoteFresh && scope === 'system' ? valid(host?.cpuPercent) : null
  const gpu = gpuFresh && scope === 'system' ? host?.gpu : null
  const metrics = (cpu: number | null, ram: number | null, total: number | null, gpuPercent: number | null, vram: number | null, vramTotal: number | null): Metric[] => [
    { label: 'CPU', value: cpu, percent: cpu },
    { label: 'GPU', value: gpuPercent, percent: gpuPercent },
    { label: 'RAM', value: ram, percent: ratio(ram, total), memory: true },
    { label: 'VRAM', value: vram, percent: ratio(vram, vramTotal), memory: true }
  ]
  const localActive = localFresh && (client?.localIndexingState === 'working' || !!snapshot?.jobs.some(j =>
    j.active && j.spans.some(s => s.status === 'running' && s.location === 'This computer')))
  const localWarning = localFresh && !!(client?.localIndexingPauseReason || client?.localComputePauseReason)
  const localStatus = !localFresh ? 'Unavailable or stale'
    : localWarning ? 'Indexing paused' : localActive ? 'Working' : 'Idle'
  const remoteState = remoteNodeState(snapshot?.host.state, host?.activeJobs.length ?? 0, remoteFresh)
  return [
    { name: 'This PC', connected: localFresh,
      active: localActive,
      warning: localWarning, status: localStatus,
      coverage: scope === 'app' ? 'Electron processes only; excludes external workers; shared RAM pages may be counted twice' : 'Whole computer',
      metrics: metrics(localCpu, localRam, valid(client?.totalRamMiB), null, null, null) },
    { name: host?.hostname || 'Gamestation', connected: remoteFresh,
      active: remoteState.active, warning: remoteState.warning, status: remoteState.status,
      coverage: scope === 'app' ? 'Host service RAM only; process CPU and GPU metrics unavailable' : 'Whole remote computer',
      metrics: metrics(remoteCpu, remoteRam, valid(host?.memoryTotalMiB), valid(gpu?.utilizationPercent), valid(gpu?.usedMiB), valid(gpu?.totalMiB)) }
  ]
}

export function PipelineNodeIndicators({ snapshot, unavailable, open, onOpen, onOptionsOpen }: {
  snapshot: PipelineTelemetry | null; unavailable: boolean; open: boolean; onOpen: () => void; onOptionsOpen?: () => void
}) {
  const [preferredDensity, setDensity] = usePreference<Density>('hidock-monitor-density', ['expanded', 'compact', 'icons'], 'compact')
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const density: Density = viewportWidth < 1150 ? 'icons'
    : viewportWidth < 1350 && preferredDensity === 'expanded' ? 'compact' : preferredDensity
  const [scope, setScope] = usePreference<Scope>('hidock-monitor-scope', ['app', 'system'], 'app')
  const [units, setUnits] = usePreference<Units>('hidock-monitor-units', ['gb', 'percent'], 'gb')
  const [options, setOptions] = useState(false)
  const [now, setNow] = useState(Date.now)
  // Age cached readings even if the existing telemetry request becomes stuck.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer) }, [])
  const nodes = nodeReadings(snapshot, scope, unavailable, now)
  const icons = [Cpu, Monitor, MemoryStick, HardDrive]
  const format = (m: Metric) => {
    const value = m.memory && units === 'percent' ? m.percent : m.value
    return value === null ? '—' : m.memory && units === 'gb' ? `${(value * 1048576 / 1e9).toFixed(1)} GB` : `${Math.round(value)}%`
  }
  return <div className="titlebar-no-drag relative flex shrink-0 items-center rounded-md border border-slate-700/80">
    {nodes.map((node, index) => {
      const Icon = index ? Server : Monitor
      const status = node.status
      const description = `${node.name} · ${scope === 'app' ? 'HiDock' : 'Whole computer'} · ${status}. ${node.metrics.map(m => `${m.label} ${format(m)}`).join(', ')}. ${node.coverage}`
      return <button key={node.name} type="button" onClick={() => { setOptions(false); onOpen() }} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Open processing monitor: ${description}`} title={description}
        style={density === 'expanded' ? { flexShrink: 0 } : undefined}
        className="flex h-9 min-w-0 items-center gap-1 px-1 text-slate-100 first:rounded-l-md [&:nth-child(2)]:border-l [&:nth-child(2)]:border-slate-700 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400">
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center" style={{ color: node.connected ? '#F8FAFC' : '#5B6472' }}>
          <Icon size={20} aria-hidden="true" />
          <span className="absolute -right-1 -top-1 rounded-sm bg-slate-900" aria-hidden="true">
            {!node.connected ? <WifiOff size={10} /> : node.warning ? <TriangleAlert size={10} color="#FFC400" /> : node.active ? <Activity size={10} color="#009FE8" /> : <span className="block h-1.5 w-1.5 rounded-full bg-slate-100" />}
          </span>
          {density === 'icons' && node.metrics.map((metric, i) => <span key={metric.label} aria-hidden="true"
            className={`absolute h-1.5 w-1.5 rounded-full ${['left-0 top-0', 'bottom-0 left-0', 'bottom-0 right-0', 'bottom-0 left-[13px]'][i]}`}
            style={{ background: metricColor(metric.percent, node.active) }} />)}
        </span>
        {density === 'expanded' && <span className="flex shrink-0 flex-col gap-0.5 text-left text-[10px] leading-[14px]">
          <span className="flex gap-1.5 whitespace-nowrap tabular-nums">
            {node.metrics.map(m =>
              <span key={m.label} style={{ color: metricColor(m.percent, node.active) }}>
                {m.label} {format(m)}
              </span>)}
          </span>
          <span className="flex items-center gap-1 whitespace-nowrap text-sky-200">
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: !node.connected ? palette.unknown : node.warning ? palette.medium : node.active ? palette.active : palette.idle }} />
            <span className="min-w-0 max-w-28 truncate">{node.name}</span>
            <span>· {status}</span>
          </span>
        </span>}
        {density === 'compact' && <span className="flex gap-1">{node.metrics.map((metric, i) => {
          const MetricIcon = icons[i]
          const color = metricColor(metric.percent, node.active)
          return <span key={metric.label} className="flex flex-col items-center gap-0.5">
            <MetricIcon size={10} aria-hidden="true" />
            <span className="rounded-[2px] px-1 text-[10px] leading-[14px] tabular-nums" style={{ background: color, color: color === palette.unknown ? '#FFFFFF' : '#08111F' }}>{format(metric)}</span>
          </span>
        })}</span>}
      </button>
    })}
    <Popover open={options} onOpenChange={next => { setOptions(next); if (next) onOptionsOpen?.() }}>
    <PopoverTrigger asChild>
      <button type="button" aria-label="Resource display options" className="h-8 shrink-0 rounded-r border-l border-slate-700 px-1 text-slate-300 hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-sky-400"><ChevronDown size={12} /></button>
    </PopoverTrigger>
    <PopoverContent align="end" sideOffset={2} className="w-60 p-3 text-xs" aria-label="Resource display options">
      <label className="mb-2 flex items-center justify-between">Density<select aria-label="Resource density" value={preferredDensity} onChange={e => setDensity(e.target.value as Density)} className="rounded bg-slate-700 p-1"><option value="expanded">Expanded</option><option value="compact">Compact</option><option value="icons">Icons only</option></select></label>
      {density !== preferredDensity && <p className="mb-2 text-slate-400">Using {density} to fit this window. Your preferred size returns when space allows.</p>}
      <label className="mb-2 flex items-center justify-between">Scope<select aria-label="Resource scope" value={scope} onChange={e => setScope(e.target.value as Scope)} className="rounded bg-slate-700 p-1"><option value="app">HiDock</option><option value="system">Whole computer</option></select></label>
      <label className="flex items-center justify-between">Memory<select aria-label="Memory units" value={units} onChange={e => setUnits(e.target.value as Units)} className="rounded bg-slate-700 p-1"><option value="gb">GB</option><option value="percent">% of capacity</option></select></label>
      <p className="mt-2 text-slate-400">CPU uses all cores as 100%. Gray means unavailable. Hover either node for measurement coverage.</p>
    </PopoverContent>
    </Popover>
  </div>
}
