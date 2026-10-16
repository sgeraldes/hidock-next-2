import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ServiceList } from '../ServiceList'

describe('ServiceList keyboard navigation', () => {
  it('has one tab stop, navigates arrows/Home/End, and leaves native button activation keys unhandled', () => {
    function Harness() {
      const [selected, setSelected] = useState('two')
      return <ServiceList label="Engines" selected={selected} onSelect={setSelected}
        items={['one', 'two', 'three'].map(id => ({ id, label: id, status: 'Ready', tone: 'ok' as const }))}>
        <button>Detail action</button>
      </ServiceList>
    }
    render(<Harness />)
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.tabIndex)).toEqual([-1, 0, -1])
    expect(options.every(option => option.parentElement?.getAttribute('role') === 'presentation')).toBe(true)
    act(() => options[1].focus())
    expect(document.activeElement).toBe(options[1])
    fireEvent.keyDown(options[1], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[2])
    expect(options.map(option => option.tabIndex)).toEqual([-1, -1, 0])
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(fireEvent.keyDown(options[2], { key: 'Enter' })).toBe(true)
    fireEvent.click(options[2])
    expect(options[2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(options[2], { key: 'Home' })
    expect(document.activeElement).toBe(options[0])
    expect(fireEvent.keyDown(options[0], { key: ' ' })).toBe(true)
    expect(options[0].tagName).toBe('BUTTON')
    fireEvent.click(options[0])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(options[0], { key: 'End' })
    expect(document.activeElement).toBe(options[2])
    fireEvent.keyDown(options[2], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(options[1])
    expect(fireEvent.keyDown(options[1], { key: 'Tab' })).toBe(true)
  })
})
