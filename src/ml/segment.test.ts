import { describe, expect, it } from 'vitest'
import { inputSize } from './segment'

describe('inputSize', () => {
  it('scales the short edge to 512 and rounds to multiples of 32', () => {
    expect(inputSize(683, 1024)).toEqual({ width: 512, height: 768 })
    expect(inputSize(1024, 1024)).toEqual({ width: 512, height: 512 })
  })

  it('caps the long edge for extreme aspect ratios', () => {
    const s = inputSize(1024, 100)
    expect(s.width).toBe(1024)
    expect(s.height % 32).toBe(0)
  })

  it('never returns a zero side', () => {
    expect(inputSize(1024, 3).height).toBe(32)
  })
})
