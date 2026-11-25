import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { PipelineMonitor } from '../PipelineMonitor'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { PipelineTelemetry } from '@/shared/pipeline-telemetry'
vi.mock('../PipelineNodeIndicators', () => ({ PipelineNodeIndicators: ({ onOpen }: { onOpen: () => void }) => <button onClick={onOpen}>Open monitor</button> }))
afterEach(cleanup)
function HeaderPopupHarness() {
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  return <>
    <Popover open={notificationsOpen} onOpenChange={setNotificationsOpen}>
      <PopoverTrigger asChild><button type="button">Open Notifications</button></PopoverTrigger>
      <PopoverContent aria-label="Notifications">Notifications panel</PopoverContent>
    </Popover>
    <PipelineMonitor />
  </>
}
const snapshot = (job: Partial<PipelineTelemetry['jobs'][0]> = {}, client: Partial<PipelineTelemetry['client']> = {}): PipelineTelemetry => ({
  sampledAt: new Date().toISOString(), revision: 1,
  client: { cpuPercent: 2, cpuPartial: false, ramMiB: 100, freeRamMiB: 20000, totalRamMiB: 64000,
    systemCpuPercent: 4, processCount: 2, eventLoopDelayMs: 1, peakEventLoopDelayMs: 1,
    localIndexingPauseReason: null, localIndexingState: 'idle', ...client },
  queue: { paused: false, pendingCount: 0, processingCount: 0 },
  host: { address: '', reachable: false, usedForSpeakers: false, telemetry: null },
  jobs: [{ recordingId: 'r', filename: 'sample.wav', active: false, canCancel: false, canResume: false,
    spans: [{ id: 'old', stage: 'diarization', tool: 'worker', model: 'voice', status: 'failed',
      startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:00:01Z', durationMs: 1000,
      location: 'This computer', device: 'cpu', tokens: null, outputTokens: null, hostJobId: null }], ...job }]
})
async function open(job = {}, host?: PipelineTelemetry['host']['telemetry'], client?: Partial<PipelineTelemetry['client']>) {
  const telemetry = vi.fn(async () => { const value = snapshot(job, client); if (host) value.host.telemetry = host; return value })
  const cancelTranscription = vi.fn(async () => ({ success: true }))
  const resumeTranscription = vi.fn(async () => ({ success: true }))
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    modelHost: { telemetry }, recordings: { cancelTranscription, resumeTranscription }
  } })
  render(<PipelineMonitor />)
  fireEvent.click(screen.getByText('Open monitor'))
  await screen.findByText(/sample.wav/)
  return { cancelTranscription, resumeTranscription }
}
it('does not turn old failures or uncancellable activity into actions', async () => {
  await open({ active: true })
  expect(screen.queryByText('Cancel')).toBeNull()
  expect(screen.queryByText('Resume from checkpoints')).toBeNull()
  fireEvent.click(screen.getByLabelText(/Include earlier audio/))
  expect(screen.queryByText('Resume from checkpoints')).toBeNull()
})
it('resumes through the checkpoint-preserving action', async () => {
  const api = await open({ canResume: true })
  fireEvent.click(screen.getByText('Resume from checkpoints'))
  await screen.findByText('Resume queued. Completed checkpoints are retained.')
  expect(api.resumeTranscription).toHaveBeenCalledWith('r')
})
it('blocks resume when the provider outcome is uncertain', async () => {
  await open({ canResume: true, uncertainProviderRequest: true })
  expect((screen.getByText('Resume from checkpoints') as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/unknown outcome/)).toBeTruthy()
})
it('sends cancellation only for a cancellable operation', async () => {
  const api = await open({ active: true, canCancel: true })
  fireEvent.click(screen.getByText('Cancel'))
  await screen.findByText(/Cancellation requested/)
  expect(api.cancelTranscription).toHaveBeenCalledWith('r')
})


it('labels completed-job token averages and coverage, without using the legacy rate', async () => {
  await open({}, { sampledAt: '', hostname: 'host', logicalCores: 24, cpuPercent: 0,
    memoryUsedMiB: 0, memoryTotalMiB: 64000, serviceRssMiB: 0, gpu: null, gpuSampledAt: null,
    activeJobs: [], recentJobs: [], completedJobs: 5, totalJobMs: 9000, tokens: 120,
    outputTokensPerSecond: 999, outputTokensPerSecondAverage: 30, tokenMeasuredJobs: 2,
    tokenMeasuredJobMs: 4000, completedJobsWithoutTokenUsage: 3,
    tokenRateBasis: 'completed-measured-job-wall-average' })
  expect(screen.getByText('Average output tokens / second')).toBeTruthy()
  expect(screen.getByText('30.0 tk/s')).toBeTruthy()
  expect(screen.getByText(/2 measured jobs \/ 3 completed without token usage/)).toBeTruthy()
  expect(screen.queryByText(/999.*tk\/s/)).toBeNull()
})

it('does not reinterpret an older host rate without an explicit average basis', async () => {
  await open({}, { sampledAt: '', hostname: 'old-host', logicalCores: 24, cpuPercent: 0,
    memoryUsedMiB: 0, memoryTotalMiB: 64000, serviceRssMiB: 0, gpu: null, gpuSampledAt: null,
    activeJobs: [], recentJobs: [], completedJobs: 5, totalJobMs: 9000, tokens: 120,
    outputTokensPerSecond: 999 })
  expect(screen.getByText('Average output tokens / second').nextElementSibling?.textContent).toBe('Unavailable')
  expect(screen.getByText('Token measurement coverage').nextElementSibling?.textContent).toBe('Unavailable')
})

it('does not return focus to the monitor opener when another header popup opens, but Escape restores it', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    modelHost: { telemetry: vi.fn(async () => snapshot()) }, recordings: {}
  } })
  render(<HeaderPopupHarness />)
  const monitorTrigger = screen.getByText('Open monitor')
  monitorTrigger.focus()
  fireEvent.click(monitorTrigger)
  await waitFor(() => expect(screen.getByRole('dialog').querySelector('h2')?.textContent).toBe('Processing monitor'))

  const notificationsTrigger = screen.getByText('Open Notifications')
  notificationsTrigger.focus()
  await new Promise(resolve => setTimeout(resolve, 10))
  fireEvent.pointerDown(notificationsTrigger, { button: 0, pointerType: 'mouse' })
  fireEvent.click(notificationsTrigger)
  const notificationsDialog = await screen.findByRole('dialog', { name: 'Notifications' })
  await waitFor(() => expect(
    notificationsDialog.contains(document.activeElement) || notificationsTrigger === document.activeElement
  ).toBe(true))
  expect(screen.queryByText('Processing monitor')).toBeNull()
  expect(monitorTrigger).not.toHaveFocus()

  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull())

  monitorTrigger.focus()
  fireEvent.click(monitorTrigger)
  await waitFor(() => expect(screen.getByRole('dialog').querySelector('h2')?.textContent).toBe('Processing monitor'))
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(monitorTrigger).toHaveFocus()
})


it('shows MiB-based client and host memory as decimal GB and preserves unavailable readings', async () => {
  const host = { sampledAt: '', hostname: 'host', logicalCores: 24, cpuPercent: 0,
    memoryUsedMiB: 1024, memoryTotalMiB: 64000, serviceRssMiB: 512,
    gpu: { name: 'GPU', utilizationPercent: null, usedMiB: 512, totalMiB: 1024 }, gpuSampledAt: null,
    activeJobs: [], recentJobs: [], completedJobs: 0, totalJobMs: 0, tokens: null,
    outputTokensPerSecond: null }
  await open({}, host, { ramMiB: 1024, freeRamMiB: 2048 })
  expect(screen.getByText('Electron working sets').nextElementSibling?.textContent).toBe('1.1 GB')
  expect(screen.getByText('System RAM available').nextElementSibling?.textContent).toBe('2.1 GB')
  expect(screen.getByText('Host RAM used').nextElementSibling?.textContent).toBe('1.1 GB')
  expect(screen.getByText('GPU memory').nextElementSibling?.textContent).toBe('0.5 GB')
})

it('keeps unavailable app and GPU MiB readings unavailable while system RAM stays measured', async () => {
  const host = { sampledAt: '', hostname: 'host', logicalCores: 24, cpuPercent: 0,
    memoryUsedMiB: 1024, memoryTotalMiB: 64000, serviceRssMiB: 512,
    gpu: { name: 'GPU', utilizationPercent: null, usedMiB: null, totalMiB: null }, gpuSampledAt: null,
    activeJobs: [], recentJobs: [], completedJobs: 0, totalJobMs: 0, tokens: null,
    outputTokensPerSecond: null }
  await open({}, host, { ramMiB: null })
  expect(screen.getByText('Electron working sets').nextElementSibling?.textContent).toBe('Unavailable')
  expect(screen.getByText('System RAM available').nextElementSibling?.textContent).toBe('21.0 GB')
  expect(screen.getByText('GPU memory').nextElementSibling?.textContent).toBe('Unavailable')
})
