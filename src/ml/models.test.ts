import { describe, expect, it } from 'vitest'
import { pickMultimask, samInputSize } from './sam'
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

describe('MobileSAM helpers', () => {
  it('resizes the long side to 1024', () => {
    expect(samInputSize(687, 1024)).toEqual({ width: 687, height: 1024 })
    expect(samInputSize(500, 250)).toEqual({ width: 1024, height: 512 })
  })
  it('picks the best multimask candidate, never mask 0', () => {
    expect(pickMultimask([0.99, 0.5, 0.9, 0.7])).toBe(2)
    expect(pickMultimask([0.1, 0.8, 0.8, 0.2])).toBe(1)
  })
})
