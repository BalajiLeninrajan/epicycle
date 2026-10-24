import { describe, expect, it } from 'vitest'
import { outerContours } from './contour'
import type { BinaryImage, Polyline } from './types'

function mask(w: number, h: number, f: (x: number, y: number) => boolean): BinaryImage {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y) ? 1 : 0
  return { width: w, height: h, data }
}

const disk = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r

function length(p: Polyline) {
  let s = 0
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])
  return s
}

/** Shoelace area, y down. Positive = clockwise on screen. */
function area(p: Polyline) {
  let a = 0
  for (let i = 2; i < p.length; i += 2) a += p[i - 2] * p[i + 1] - p[i] * p[i - 1]
  return a / 2
}

const isClosed = (p: Polyline) => p[0] === p[p.length - 2] && p[1] === p[p.length - 1]

describe('outerContours', () => {
  it('returns nothing for empty masks', () => {
    expect(outerContours(mask(10, 10, () => false))).toEqual([])
    expect(outerContours({ width: 0, height: 0, data: new Uint8Array(0) })).toEqual([])
  })

  it('outlines a single pixel with a diamond around its center', () => {
    const out = outerContours(mask(5, 5, (x, y) => x === 2 && y === 2))
    expect(out).toHaveLength(1)
    const p = out[0]
    expect(isClosed(p)).toBe(true)
    expect(p.length / 2).toBe(5)
    const pts = new Set<string>()
    for (let i = 0; i < p.length - 2; i += 2) pts.add(`${p[i]},${p[i + 1]}`)
    expect([...pts].sort()).toEqual(['1.5,2', '2,1.5', '2,2.5', '2.5,2'])
    expect(area(p)).toBeCloseTo(0.5)
  })

  it('has length close to 2 pi r for a filled circle', () => {
    const r = 40
    const out = outerContours(mask(100, 100, disk(50, 50, r)))
    expect(out).toHaveLength(1)
    const p = out[0]
    expect(isClosed(p)).toBe(true)
    // Marching squares on a binary mask uses 0/45/90 degree steps, which overestimates by ~5%.
    expect(length(p) / (2 * Math.PI * r)).toBeGreaterThan(0.98)
    expect(length(p) / (2 * Math.PI * r)).toBeLessThan(1.08)
    expect(area(p) / (Math.PI * r * r)).toBeCloseTo(1, 1)
    let sx = 0
    let sy = 0
    for (let i = 0; i < p.length - 2; i += 2) {
      sx += p[i]
      sy += p[i + 1]
    }
    const k = p.length / 2 - 1
    expect(sx / k).toBeCloseTo(50, 1)
    expect(sy / k).toBeCloseTo(50, 1)
  })

  it('ignores holes', () => {
    const d = disk(30, 30, 20)
    const hole = disk(30, 30, 8)
    const out = outerContours(mask(60, 60, (x, y) => d(x, y) && !hole(x, y)))
    expect(out).toHaveLength(1)
    expect(length(out[0]) / (2 * Math.PI * 20)).toBeGreaterThan(0.98)
    expect(area(out[0])).toBeGreaterThan(0)
  })

  it('returns an island inside a hole as its own outer contour', () => {
    const outer = disk(30, 30, 25)
    const hole = disk(30, 30, 15)
    const island = disk(30, 30, 5)
    const out = outerContours(mask(60, 60, (x, y) => (outer(x, y) && !hole(x, y)) || island(x, y)))
    expect(out).toHaveLength(2)
    for (const p of out) expect(area(p)).toBeGreaterThan(0)
  })

  it('closes shapes touching the image border', () => {
    const out = outerContours(mask(8, 6, () => true))
    expect(out).toHaveLength(1)
    const p = out[0]
    expect(isClosed(p)).toBe(true)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i])
      maxX = Math.max(maxX, p[i])
      minY = Math.min(minY, p[i + 1])
      maxY = Math.max(maxY, p[i + 1])
    }
    expect([minX, maxX, minY, maxY]).toEqual([-0.5, 7.5, -0.5, 5.5])
    // Rectangle with the four corners cut by 45 degree segments.
    expect(area(p)).toBeCloseTo(8 * 6 - 4 * 0.125)
  })

  it('returns one contour per blob, all clockwise', () => {
    const a = disk(10, 10, 5)
    const b = disk(30, 10, 5)
    const out = outerContours(mask(40, 20, (x, y) => a(x, y) || b(x, y) || (x === 39 && y === 19)))
    expect(out).toHaveLength(3)
    for (const p of out) {
      expect(isClosed(p)).toBe(true)
      expect(area(p)).toBeGreaterThan(0)
    }
  })

  it('treats diagonally touching pixels as one blob', () => {
    const out = outerContours(mask(4, 4, (x, y) => (x === 1 && y === 1) || (x === 2 && y === 2)))
    expect(out).toHaveLength(1)
    expect(area(out[0])).toBeGreaterThan(0)
  })
})
