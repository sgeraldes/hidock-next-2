import { expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { dashboardScript } from '../src/dashboard.mjs'

class Element {
  children = []
  textContent = ''
  className = ''
  replaceChildren(...children) { this.children = children }
  append(...children) { this.children.push(...children) }
}

async function renderDashboard(data) {
  const elements = new Map(['state', 'metrics', 'jobs'].map((id) => [id, new Element()]))
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => new Element(),
  }
  runInNewContext(dashboardScript, {
    document,
    fetch: async () => ({ ok: true, json: async () => data }),
    AbortSignal: { timeout: () => ({}) },
    setTimeout: () => 0,
  })
  await new Promise((resolve) => setImmediate(resolve))
  return elements.get('metrics').children
}

function metric(metrics, label) {
  const index = metrics.findIndex((element) => element.textContent === label)
  return metrics[index + 1]?.textContent
}

const telemetry = (overrides = {}) => ({
  hostname: 'host', activeJobs: [], recentJobs: [], hostState: 'ready', sampledAt: '', logicalCores: 1,
  cpuPercent: 0, memoryUsedMiB: 1024, memoryTotalMiB: 64000, serviceRssMiB: 512,
  gpu: { name: 'GPU', utilizationPercent: null, usedMiB: 512, totalMiB: 1024 }, gpuSampledAt: null,
  completedJobs: 0, totalJobMs: 0, tokens: null, tokenMeasuredJobs: 0,
  outputTokensPerSecondAverage: null, ...overrides,
})

it('renders MiB-based host, service, and GPU memory in decimal GB', async () => {
  const metrics = await renderDashboard(telemetry())
  expect(metric(metrics, 'Host RAM')).toBe('1.1 GB / 67.1 GB')
  expect(metric(metrics, 'Service RAM · excludes model workers')).toBe('0.5 GB')
  expect(metric(metrics, 'GPU memory')).toBe('0.5 GB / 1.1 GB')
})

it('keeps unknown memory readings unavailable', async () => {
  const metrics = await renderDashboard(telemetry({
    memoryUsedMiB: null, memoryTotalMiB: null, serviceRssMiB: null,
    gpu: { name: 'GPU', utilizationPercent: null, usedMiB: null, totalMiB: null },
  }))
  expect(metric(metrics, 'Host RAM')).toBe('Unavailable / Unavailable')
  expect(metric(metrics, 'Service RAM · excludes model workers')).toBe('Unavailable')
  expect(metric(metrics, 'GPU memory')).toBe('Unavailable / Unavailable')
})
