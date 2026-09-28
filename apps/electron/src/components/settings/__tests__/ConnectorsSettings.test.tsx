import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ConnectorsSettings } from '../ConnectorsSettings'

function summary(instanceId: string, type: string, label: string, state: string, multiInstance = false) {
  return {
    instanceId,
    label,
    multiInstance,
    status: { state },
    descriptor: {
      id: type,
      displayName: type === 'm365' ? 'Microsoft 365' : 'Slack',
      description: type === 'm365' ? 'Outlook calendar and contacts.' : 'Channels as living logs.',
      transport: 'native',
      multiInstance,
      setupOptional: type === 'm365',
      auth: { kind: type === 'm365' ? 'oauth' : 'api-key', setupSteps: [] },
      configFields: [],
      capabilityKinds: ['sources']
    },
    fields: [],
    sources: []
  }
}

const list = vi.fn()
const addInstance = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([
    summary('m365', 'm365', 'Microsoft 365', 'connected', true),
    summary('slack', 'slack', 'Slack', 'auth-needed')
  ])
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    connectors: {
      list,
      addInstance,
      listContainers: vi.fn(async () => []),
      onStatusChanged: () => () => undefined
    }
  }
})

describe('ConnectorsSettings as a list and a detail pane', () => {
  it('lists every connector with its state and shows the first one', async () => {
    render(<ConnectorsSettings />)
    const listbox = await screen.findByRole('listbox', { name: 'Connectors' })
    const options = within(listbox).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Microsoft 365Connected', 'SlackSign-in needed'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { level: 3, name: 'Microsoft 365' })).toBeInTheDocument()
  })

  it('opens another connector from the list', async () => {
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('option', { name: /Slack/ }))
    expect(screen.getByRole('heading', { level: 3, name: 'Slack' })).toBeInTheDocument()
    expect(screen.getByText('Channels as living logs.')).toBeInTheDocument()
  })

  it('adds a second account under the list and selects it', async () => {
    addInstance.mockResolvedValue(summary('m365:2', 'm365', 'Personal', 'auth-needed', true))
    render(<ConnectorsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add Microsoft 365 account' }))
    const option = await screen.findByRole('option', { name: /Microsoft 365 · Personal/ })
    expect(option).toHaveAttribute('aria-selected', 'true')
    expect(addInstance).toHaveBeenCalledWith('m365')
  })
})
