import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useKeyboardNavigation } from '../useKeyboardNavigation'

function GridHarness({ count, columns }: { count: number; columns: number }) {
  const items = Array.from({ length: count }, (_, i) => `r${i}`)
  const { handleKeyDown, focusedIndex } = useKeyboardNavigation({
    items,
    selectedIds: new Set<string>(),
    onToggleSelection: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    columns,
    isEnabled: true
  })
  return (
    <div data-testid="grid" tabIndex={0} onKeyDown={handleKeyDown}>
      <span data-testid="focused">{focusedIndex}</span>
    </div>
  )
}

function press(getByTestId: (id: string) => HTMLElement, keys: string[]) {
  for (const key of keys) fireEvent.keyDown(getByTestId('grid'), { key })
  return getByTestId('focused').textContent
}

describe('useKeyboardNavigation in a grid', () => {
  it('Down and Up move a whole row, Left and Right one card', () => {
    const { getByTestId } = render(<GridHarness count={10} columns={3} />)
    // The first key press focuses the first card.
    expect(press(getByTestId, ['ArrowDown'])).toBe('0')
    expect(press(getByTestId, ['ArrowDown'])).toBe('3')
    expect(press(getByTestId, ['ArrowRight'])).toBe('4')
    expect(press(getByTestId, ['ArrowDown'])).toBe('7')
    expect(press(getByTestId, ['ArrowUp'])).toBe('4')
    expect(press(getByTestId, ['ArrowLeft'])).toBe('3')
  })

  it('stops at the edges instead of wrapping or leaving the grid', () => {
    const { getByTestId } = render(<GridHarness count={8} columns={3} />)
    expect(press(getByTestId, ['ArrowDown', 'ArrowUp'])).toBe('0')
    expect(press(getByTestId, ['ArrowLeft'])).toBe('0')
    expect(press(getByTestId, ['ArrowDown', 'ArrowDown', 'ArrowDown'])).toBe('6')
    expect(press(getByTestId, ['ArrowRight', 'ArrowRight', 'ArrowRight'])).toBe('7')
  })

  it('a short last row: Down from a card with nothing below goes to the last card', () => {
    const { getByTestId } = render(<GridHarness count={8} columns={3} />)
    // 0, then 3, then 6 (third row, first column), right to 7, and down stays in the last row.
    expect(press(getByTestId, ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowDown'])).toBe('7')
    // From 4 (second row, middle) down would be 7, which exists.
    expect(press(getByTestId, ['ArrowUp', 'ArrowUp'])).toBe('1')
    expect(press(getByTestId, ['ArrowDown'])).toBe('4')
    expect(press(getByTestId, ['ArrowDown'])).toBe('7')
    // From 5 (second row, right) down would be 8, which does not exist: the last card.
    expect(press(getByTestId, ['ArrowUp', 'ArrowRight'])).toBe('5')
    expect(press(getByTestId, ['ArrowDown'])).toBe('7')
  })

  it('one column behaves like a list', () => {
    const { getByTestId } = render(<GridHarness count={4} columns={1} />)
    expect(press(getByTestId, ['ArrowDown', 'ArrowDown', 'ArrowDown'])).toBe('2')
    expect(press(getByTestId, ['ArrowUp'])).toBe('1')
  })
})
