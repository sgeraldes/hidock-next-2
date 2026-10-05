import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HashRouter, MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../ErrorBoundary'

function Broken(): never { throw new Error('Library fixture failed') }
function Harness() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><button onClick={() => navigate('/notes')}>Notes</button>
    <ErrorBoundary resetKeys={[location]}>
      {location.pathname === '/library' ? <Broken /> : <p>Notes editor</p>}
    </ErrorBoundary></>
}
it('recovers on navigation without reloading', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<MemoryRouter initialEntries={['/library']}><Harness /></MemoryRouter>)
  expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  fireEvent.click(screen.getByText('Notes'))
  expect(screen.getByText('Notes editor')).toBeInTheDocument()
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
  log.mockRestore()
})

it('also recovers when a hash route changes without a new history key', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  window.location.hash = '#/library'
  render(<HashRouter><Harness /></HashRouter>)
  expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  window.location.hash = '#/notes'
  await waitFor(() => expect(screen.getByText('Notes editor')).toBeInTheDocument())
  log.mockRestore()
})
