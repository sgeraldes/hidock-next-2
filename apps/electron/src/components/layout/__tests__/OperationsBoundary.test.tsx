import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { OperationsBoundary } from '../OperationsBoundary'

describe('Operations isolation', () => {
  it('keeps the surrounding layout visible and offers recovery after an Operations crash', () => {
    function Broken(): never { throw new Error('getSnapshot failed') }
    render(<><main>Library remains visible</main><OperationsBoundary><Broken /></OperationsBoundary></>)
    expect(screen.getByText('Library remains visible')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Operations could not be displayed')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Library remains visible')).toBeVisible()
  })
})
