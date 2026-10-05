import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../ErrorBoundary'

function Broken(): never { throw new Error('Library fixture failed') }
function Harness() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><button onClick={() => navigate('/notes')}>Notes</button>
    <ErrorBoundary resetKeys={[location.key]}>
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
