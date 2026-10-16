import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { metricColor, nodeReadings, PipelineNodeIndicators } from '../PipelineNodeIndicators'
import type { PipelineTelemetry } from '@/shared/pipeline-telemetry'

const initialWidth = window.innerWidth
afterEach(() => {
  cleanup()
  localStorage.clear()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth })
})
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  fireEvent(window, new Event('resize'))
}
function renderedDensity(button: HTMLElement): 'expanded' | 'compact' | 'icons' {
  if (button.querySelector('span.max-w-28')) return 'expanded'
  if ([...button.querySelectorAll('span')].some(span => span.classList.contains('rounded-[2px]'))) return 'compact'
  return 'icons'
}
const snapshot = (): PipelineTelemetry => ({
  sampledAt: new Date().toISOString(),
  client: { cpuPercent: 5, cpuPartial: false, ramMiB: 2048, totalRamMiB: 65536, freeRamMiB: 32768,
    systemCpuPercent: 70, processCount: 4, eventLoopDelayMs: 1, peakEventLoopDelayMs: 2,
    localIndexingState: 'idle', localIndexingPauseReason: null },
  queue: { paused: false, processingCount: 0, pendingCount: 0 }, jobs: [],
  host: { address: 'remote', reachable: true, state: 'ready', usedForSpeakers: true, telemetry: {
    sampledAt: new Date().toISOString(), hostname: 'GAMESTATION', logicalCores: 32, cpuPercent: 60,
    memoryUsedMiB: 32768, memoryTotalMiB: 65536, serviceRssMiB: 1024,
    gpuSampledAt: new Date().toISOString(), gpu: { name: '4090', utilizationPercent: 90, usedMiB: 12000, totalMiB: 24000 },
    activeJobs: [], recentJobs: [], completedJobs: 0, totalJobMs: 0, tokens: null, outputTokensPerSecond: null
  } }
})
describe('resource indicators', () => {
  it('dismisses options on outside interaction and Escape without a close command', async () => {
    const onOptionsOpen = vi.fn()
    render(<><button>Outside</button><PipelineNodeIndicators snapshot={snapshot()} unavailable={false}
      open={false} onOpen={vi.fn()} onOptionsOpen={onOptionsOpen} /></>)
    const trigger = screen.getByRole('button', { name: 'Resource display options' })
    fireEvent.click(trigger)
    expect(onOptionsOpen).toHaveBeenCalledOnce()
    expect(screen.queryByText('Close options')).toBeNull()
    fireEvent.change(screen.getByLabelText('Memory units'), { target: { value: 'percent' } })
    expect(screen.getByRole('dialog')).toBeTruthy()
    // Radix attaches its document pointer listener after the opening event.
    await new Promise(resolve => setTimeout(resolve, 10))
    fireEvent.pointerDown(screen.getByText('Outside'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('does not substitute host totals for unmeasured app GPU or CPU', () => {
    const nodes = nodeReadings(snapshot(), 'app', false, Date.now())
    expect(nodes[0].metrics[0].value).toBe(5)
    expect(nodes[0].metrics[2].value).toBe(2048)
    expect(nodes[1].metrics[0].value).toBeNull()
    expect(nodes[1].metrics[1].value).toBeNull()
    expect(nodes[1].metrics[2].value).toBe(1024)
    const totals = nodeReadings(snapshot(), 'system', false, Date.now())
    expect(totals[0].metrics[0].value).toBe(70)
    expect(totals[1].metrics[3].percent).toBe(50)
  })
  it('expires all readings and does not treat cloud work as local activity', () => {
    const s = snapshot()
    s.jobs = [{ recordingId: '1', filename: 'audio', active: true, spans: [{ status: 'running', location: 'Gemini' } as never] }]
    expect(nodeReadings(s, 'app', false, Date.now())[0].active).toBe(false)
    expect(nodeReadings(s, 'system', false, Date.now() + 46000).every(n => !n.connected && n.metrics.every(m => m.value === null))).toBe(true)
  })
  it('shows paused and stopped hosts as connected but unavailable for work', () => {
    const s = snapshot()
    s.host.telemetry!.activeJobs.push({ id: 'stale-job', stage: 'diarization', model: 'voice', recordingId: '1', elapsedMs: 5000 })
    for (const [state, status] of [['paused', 'Paused'], ['stopped', 'Stopped']] as const) {
      s.host.state = state
      const host = nodeReadings(s, 'app', false, Date.now())[1]
      expect(host.connected).toBe(true)
      expect(host.active).toBe(false)
      expect(host.warning).toBe(true)
      expect(host.status).toBe(status)
    }
  })
  it('shows unknown host states explicitly and only treats ready or busy as work-capable', () => {
    const s = snapshot()
    s.host.state = 'warming-up'
    let host = nodeReadings(s, 'app', false, Date.now())[1]
    expect(host.connected).toBe(true)
    expect(host.active).toBe(false)
    expect(host.warning).toBe(true)
    expect(host.status).toBe('Unknown state (warming-up)')

    delete s.host.state
    host = nodeReadings(s, 'app', false, Date.now())[1]
    expect(host.status).toBe('State unknown')
  })
  it('uses host state and active jobs to distinguish busy, ready-idle, and ready-working', () => {
    const s = snapshot()
    s.host.state = 'busy'
    expect(nodeReadings(s, 'app', false, Date.now())[1]).toMatchObject({ active: true, status: 'Working' })
    s.host.state = 'ready'
    s.host.telemetry!.activeJobs.length = 0
    expect(nodeReadings(s, 'app', false, Date.now())[1]).toMatchObject({ active: false, status: 'Idle' })
    s.host.telemetry!.activeJobs.push({ id: 'job', stage: 'diarization', model: 'voice', recordingId: '1', elapsedMs: 5000 })
    expect(nodeReadings(s, 'app', false, Date.now())[1]).toMatchObject({ active: true, status: 'Working' })
  })
  it('keeps pressure colors separate from activity', () => {
    expect(metricColor(null, true)).toBe('#5B6472')
    expect(metricColor(0, false)).toBe('#F8FAFC')
    expect(metricColor(10, true)).toBe('#009FE8')
    expect(metricColor(50, false)).toBe('#FFC400')
    expect(metricColor(80, true)).toBe('#F04438')
  })
  it('opens the monitor from either node and persists independent preferences', () => {
    const onOpen = vi.fn()
    render(<PipelineNodeIndicators snapshot={snapshot()} unavailable={false} open={false} onOpen={onOpen} />)
    screen.getAllByRole('button', { name: /Open processing monitor/ }).forEach(button => fireEvent.click(button))
    expect(onOpen).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Resource display options' }))
    fireEvent.change(screen.getByLabelText('Memory units'), { target: { value: 'percent' } })
    fireEvent.change(screen.getByLabelText('Resource scope'), { target: { value: 'system' } })
    fireEvent.change(screen.getByLabelText('Resource density'), { target: { value: 'icons' } })
    expect(localStorage.getItem('hidock-monitor-units')).toBe('percent')
    expect(localStorage.getItem('hidock-monitor-scope')).toBe('system')
    expect(localStorage.getItem('hidock-monitor-density')).toBe('icons')
  })
  it('reserves a wider compact band before restoring expanded labels', async () => {
    localStorage.setItem('hidock-monitor-density', 'expanded')
    const onOpen = vi.fn()
    const renderIndicators = () => render(<PipelineNodeIndicators snapshot={snapshot()} unavailable={false} open={false} onOpen={onOpen} />)

    setViewportWidth(1149)
    let view = renderIndicators()
    expect(renderedDensity(screen.getAllByRole('button', { name: /Open processing monitor/ })[0])).toBe('icons')
    view.unmount()

    setViewportWidth(1150)
    view = renderIndicators()
    await waitFor(() => expect(renderedDensity(screen.getAllByRole('button', { name: /Open processing monitor/ })[0])).toBe('compact'))
    view.unmount()

    setViewportWidth(1349)
    view = renderIndicators()
    await waitFor(() => expect(renderedDensity(screen.getAllByRole('button', { name: /Open processing monitor/ })[0])).toBe('compact'))
    view.unmount()

    setViewportWidth(1350)
    renderIndicators()
    await waitFor(() => expect(renderedDensity(screen.getAllByRole('button', { name: /Open processing monitor/ })[0])).toBe('expanded'))
  })
})
