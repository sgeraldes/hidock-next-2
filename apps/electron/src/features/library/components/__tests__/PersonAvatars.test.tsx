import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PersonAvatars } from '../PersonAvatars'
import { avatarColor, type CardPerson } from '../../utils/cardInfo'

const person = (name: string, spoke = true): CardPerson => ({ key: `${spoke ? 's' : 'i'}:${name}`, name, spoke })

describe('PersonAvatars', () => {
  it('draws nothing for nobody', () => {
    const { container } = render(<PersonAvatars people={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws a circle with initials for each person, in their own colour', () => {
    render(<PersonAvatars people={[person('Ana Pérez'), person('Luis Gómez')]} />)
    const ana = screen.getByRole('img', { name: 'Ana Pérez' })
    expect(ana).toHaveTextContent('AP')
    expect(ana).toHaveClass('rounded-full')
    expect(ana.style.backgroundColor).toMatch(/hsl|rgb/)
    expect(screen.getByRole('img', { name: 'Luis Gómez' })).toHaveTextContent('LG')
  })

  it('shows four and counts the rest', () => {
    const people = ['Ana Pérez', 'Luis Gómez', 'Marta Ríos', 'Jorge Díaz', 'Sofía Luna', 'Pablo Mora'].map((n) => person(n))
    render(<PersonAvatars people={people} />)
    expect(screen.getAllByRole('img')).toHaveLength(4)
    expect(screen.getByTestId('card-people-more')).toHaveTextContent('+2')
    // The full list is one hover away.
    expect(screen.getByTestId('card-people').getAttribute('title')).toContain('Pablo Mora')
  })

  it('draws someone who was only invited in a muted colour, and says so', () => {
    render(<PersonAvatars people={[person('Ana Pérez'), person('Marta Ríos', false)]} />)
    const spoke = screen.getByRole('img', { name: 'Ana Pérez' })
    const invited = screen.getByRole('img', { name: 'Marta Ríos, invited' })
    expect(invited.getAttribute('data-spoke')).toBe('false')
    expect(spoke.getAttribute('data-spoke')).toBe('true')
    // The browser (and jsdom) may write the colour in another notation; compare through the same conversion.
    const inStyle = (color: string) => {
      const probe = document.createElement('span')
      probe.style.backgroundColor = color
      return probe.style.backgroundColor
    }
    expect(invited.style.backgroundColor).toBe(inStyle(avatarColor('Marta Ríos', false)))
    expect(spoke.style.backgroundColor).toBe(inStyle(avatarColor('Ana Pérez', true)))
    expect(avatarColor('Marta Ríos', false)).not.toBe(avatarColor('Marta Ríos', true))
  })

  it('never lets one circle hide the letters of the next: they overlap by 2 px behind a 1 px ring', () => {
    render(<PersonAvatars people={[person('Ana Pérez'), person('Luis Gómez')]} />)
    expect(screen.getByTestId('card-people')).toHaveClass('-space-x-0.5')
    expect(screen.getByRole('img', { name: 'Ana Pérez' })).toHaveClass('w-5')
  })

  it('takes the number of circles from the caller', () => {
    render(<PersonAvatars people={[person('A B'), person('C D'), person('E F')]} max={2} />)
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByTestId('card-people-more')).toHaveTextContent('+1')
  })
})
