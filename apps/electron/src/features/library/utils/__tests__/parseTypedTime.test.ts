import { describe, it, expect } from 'vitest'
import { parseTypedTime } from '../formatTimestamp'

describe('parseTypedTime', () => {
  it.each([
    ['75', 75],
    ['1:15', 75],
    ['1:15.5', 75.5],
    ['1:02:03', 3723],
    [' 0:07 ', 7]
  ])('reads %s', (text, seconds) => {
    expect(parseTypedTime(text)).toBe(seconds)
  })

  it.each(['', 'abc', '1:75', '1:60:00', '1.5:10', '1:2:3:4', '-5'])('refuses %s', (text) => {
    expect(parseTypedTime(text)).toBeNull()
  })
})
