import { describe, expect, it } from 'vitest'
import { gaussianBlur, resizeGray, toGray } from './image'
import type { GrayImage } from './types'

function gray(width: number, height: number, fn: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y)
  return { width, height, data }
}

function sum(a: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s
}

describe('toGray', () => {
  it('uses Rec. 709 weights', () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
      0, 0, 0, 255,
      128, 128, 128, 255,
    ])
    const g = toGray(rgba, 3, 2)
    expect(g.width).toBe(3)
    expect(g.height).toBe(2)
    expect(g.data[0]).toBeCloseTo(0.2126, 5)
    expect(g.data[1]).toBeCloseTo(0.7152, 5)
    expect(g.data[2]).toBeCloseTo(0.0722, 5)
    expect(g.data[3]).toBeCloseTo(1, 5)
    expect(g.data[4]).toBe(0)
    expect(g.data[5]).toBeCloseTo(128 / 255, 5)
  })

  it('treats transparent pixels as white and composites partial alpha over white', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 51])
    const g = toGray(rgba, 2, 1)
    expect(g.data[0]).toBe(1)
    expect(g.data[1]).toBeCloseTo(0.8, 5)
  })

  it('handles empty input', () => {
    expect(toGray(new Uint8ClampedArray(0), 0, 0).data.length).toBe(0)
  })
})

describe('gaussianBlur', () => {
  it('returns a copy for sigma <= 0', () => {
    const img = gray(4, 3, (x, y) => x + y)
    const out = gaussianBlur(img, 0)
    expect(out.data).toEqual(img.data)
    expect(out.data).not.toBe(img.data)
  })

  it('keeps a constant image constant, including at the borders', () => {
    const out = gaussianBlur(gray(7, 5, () => 0.3), 2)
    for (const v of out.data) expect(v).toBeCloseTo(0.3, 5)
  })

  it('spreads an impulse symmetrically and preserves its mass', () => {
    const w = 31
    const img = gray(w, w, (x, y) => (x === 15 && y === 15 ? 1 : 0))
    const out = gaussianBlur(img, 2)
    expect(sum(out.data)).toBeCloseTo(1, 4)
    const at = (x: number, y: number) => out.data[y * w + x]
    expect(at(15, 15)).toBeGreaterThan(at(16, 15))
    expect(at(14, 15)).toBeCloseTo(at(16, 15), 6)
    expect(at(15, 12)).toBeCloseTo(at(18, 15), 6)
    expect(at(13, 13)).toBeCloseTo(at(17, 17), 6)
    // Radius is ceil(3 sigma) = 6, so nothing reaches 7 pixels away.
    expect(at(22, 15)).toBe(0)
    expect(at(21, 15)).toBeGreaterThan(0)
  })

  it('works on a single pixel and on 1-wide images', () => {
    expect(gaussianBlur(gray(1, 1, () => 0.7), 3).data[0]).toBeCloseTo(0.7, 5)
    const col = gaussianBlur(gray(1, 9, (_, y) => (y === 4 ? 1 : 0)), 1)
    expect(sum(col.data)).toBeCloseTo(1, 4)
    expect(col.data[4]).toBeGreaterThan(col.data[3])
  })

  it('handles an empty image', () => {
    expect(gaussianBlur({ width: 0, height: 0, data: new Float32Array(0) }, 2).data.length).toBe(0)
  })
})

describe('resizeGray', () => {
  it('returns an equal copy at the same size', () => {
    const img = gray(5, 4, (x, y) => (x * 3 + y) / 20)
    const out = resizeGray(img, 5, 4)
    expect(out.data).toEqual(img.data)
    expect(out.data).not.toBe(img.data)
  })

  it('keeps constants constant when scaling either way', () => {
    const img = gray(40, 30, () => 0.25)
    for (const [w, h] of [[10, 7], [97, 61], [1, 1]] as const) {
      const out = resizeGray(img, w, h)
      expect(out.width).toBe(w)
      expect(out.height).toBe(h)
      for (const v of out.data) expect(v).toBeCloseTo(0.25, 5)
    }
  })

  it('reproduces a linear ramp on upscale', () => {
    const img = gray(4, 1, (x) => x / 3)
    const out = resizeGray(img, 8, 1)
    // Interior samples follow the ramp; the ends clamp.
    for (let x = 1; x < 7; x++) {
      const s = Math.min(3, Math.max(0, (x + 0.5) / 2 - 0.5))
      expect(out.data[x]).toBeCloseTo(s / 3, 5)
    }
    expect(out.data[0]).toBeCloseTo(0, 5)
    expect(out.data[7]).toBeCloseTo(1, 5)
  })

  it('does not alias a fine checkerboard on 4x downscale', () => {
    const img = gray(256, 256, (x, y) => ((x + y) & 1 ? 1 : 0))
    const out = resizeGray(img, 64, 64)
    for (const v of out.data) expect(Math.abs(v - 0.5)).toBeLessThan(0.05)
  })

  it('does not alias stripes with period near the target pitch', () => {
    // Period 3 stripes downsampled 4x: point sampling would give a strong beat pattern.
    const img = gray(240, 8, (x) => (x % 3 === 0 ? 1 : 0))
    const out = resizeGray(img, 60, 2)
    let lo = Infinity
    let hi = -Infinity
    // Interior only: clamp-to-edge replicates the bright first column.
    for (let x = 3; x < 57; x++) {
      const v = out.data[x]
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    expect(hi - lo).toBeLessThan(0.05)
    expect(lo).toBeGreaterThan(0.28)
  })

  it('preserves the location of a bright block on downscale', () => {
    const img = gray(64, 64, (x, y) => (x >= 32 && y < 32 ? 1 : 0))
    const out = resizeGray(img, 16, 16)
    expect(out.data[2 * 16 + 13]).toBeGreaterThan(0.9)
    expect(out.data[13 * 16 + 2]).toBeLessThan(0.1)
  })

  it('handles empty source and empty target', () => {
    expect(resizeGray(gray(4, 4, () => 1), 0, 3).data.length).toBe(0)
    const fromEmpty = resizeGray({ width: 0, height: 0, data: new Float32Array(0) }, 3, 2)
    expect(fromEmpty.data.length).toBe(6)
  })
})
