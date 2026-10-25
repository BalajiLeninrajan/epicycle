import { describe, expect, it } from 'vitest'
import { stipple, tourPoints } from './stipple'
import type { BinaryImage, GrayImage } from './types'

function grayImage(w: number, h: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y)
  return { width: w, height: h, data }
}

function tourLength(p: Float32Array): number {
  const n = p.length >> 1
  let len = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    len += Math.hypot(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1])
  }
  return len
}

function randomPoints(n: number, seed: number, size = 1000): Float32Array {
  let s = seed
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  const p = new Float32Array(n * 2)
  for (let i = 0; i < p.length; i++) p[i] = rand() * size
  return p
}

function pointKeys(p: Float32Array): string[] {
  const keys: string[] = []
  for (let i = 0; i < p.length; i += 2) keys.push(`${p[i]},${p[i + 1]}`)
  return keys.sort()
}

describe('stipple', () => {
  // Left half dark, right half light.
  const halves = grayImage(200, 100, (x) => (x < 100 ? 0.1 : 0.9))

  it('is deterministic for a fixed seed', () => {
    const a = stipple(halves, null, { count: 300, iterations: 5, seed: 42 })
    const b = stipple(halves, null, { count: 300, iterations: 5, seed: 42 })
    const c = stipple(halves, null, { count: 300, iterations: 5, seed: 43 })
    expect(a.length).toBe(600)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(Array.from(a)).not.toEqual(Array.from(c))
  })

  it('puts more dots in dark regions', () => {
    const p = stipple(halves, null, { count: 500, iterations: 10, seed: 1 })
    let dark = 0
    let light = 0
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < 99.5) dark++
      else light++
    }
    expect(dark + light).toBe(500)
    // Density ratio is 9:1.
    expect(dark).toBeGreaterThan(light * 4)
  })

  it('matches a brute-force Lloyd step', () => {
    const w = 90
    const h = 70
    const img = grayImage(w, h, (x, y) => 0.5 + 0.4 * Math.sin(x / 9) * Math.cos(y / 7))
    const init = stipple(img, null, { count: 60, iterations: 0, seed: 9 })
    const once = stipple(img, null, { count: 60, iterations: 1, seed: 9 })
    const n = init.length >> 1
    const sw = new Float64Array(n)
    const sx = new Float64Array(n)
    const sy = new Float64Array(n)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = 1 - img.data[y * w + x]
        let best = 0
        let bestD = Infinity
        for (let k = 0; k < n; k++) {
          const d2 = (init[2 * k] - x) ** 2 + (init[2 * k + 1] - y) ** 2
          if (d2 < bestD) {
            bestD = d2
            best = k
          }
        }
        sw[best] += d
        sx[best] += d * x
        sy[best] += d * y
      }
    }
    for (let k = 0; k < n; k++) {
      if (sw[k] === 0) continue
      expect(once[2 * k]).toBeCloseTo(sx[k] / sw[k], 3)
      expect(once[2 * k + 1]).toBeCloseTo(sy[k] / sw[k], 3)
    }
  })

  it('keeps dots inside the image', () => {
    const img = grayImage(64, 48, () => 0)
    const p = stipple(img, null, { count: 200, iterations: 8, seed: 3 })
    for (let i = 0; i < p.length; i += 2) {
      expect(p[i]).toBeGreaterThanOrEqual(-0.5)
      expect(p[i]).toBeLessThanOrEqual(63.5)
      expect(p[i + 1]).toBeGreaterThanOrEqual(-0.5)
      expect(p[i + 1]).toBeLessThanOrEqual(47.5)
    }
  })

  it('excludes dots outside the mask', () => {
    const w = 120
    const h = 80
    const img = grayImage(w, h, () => 0.2)
    const mask: BinaryImage = { width: w, height: h, data: new Uint8Array(w * h) }
    // Circle of radius 25 at (60, 40).
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - 60) ** 2 + (y - 40) ** 2 <= 625) mask.data[y * w + x] = 1
    const p = stipple(img, mask, { count: 150, iterations: 10, seed: 7 })
    expect(p.length).toBe(300)
    for (let i = 0; i < p.length; i += 2) {
      expect(Math.hypot(p[i] - 60, p[i + 1] - 40)).toBeLessThanOrEqual(26)
    }
  })

  it('returns nothing when density is zero', () => {
    const white = grayImage(50, 50, () => 1)
    expect(stipple(white, null, { count: 100, iterations: 5 }).length).toBe(0)
    const dark = grayImage(50, 50, () => 0)
    const empty: BinaryImage = { width: 50, height: 50, data: new Uint8Array(2500) }
    expect(stipple(dark, empty, { count: 100, iterations: 5 }).length).toBe(0)
    expect(stipple(dark, null, { count: 0, iterations: 5 }).length).toBe(0)
  })

  it('handles a single dark pixel at the border', () => {
    const img = grayImage(30, 20, (x, y) => (x === 29 && y === 0 ? 0 : 1))
    const p = stipple(img, null, { count: 10, iterations: 5 })
    expect(p.length).toBe(2)
    expect(p[0]).toBeCloseTo(29)
    expect(p[1]).toBeCloseTo(0)
  })

  it('handles a sparse dark spot on a faint background', () => {
    const img = grayImage(100, 100, (x, y) => (Math.hypot(x - 20, y - 20) < 3 ? 0 : 0.999))
    const p = stipple(img, null, { count: 50, iterations: 10, seed: 5 })
    expect(p.length).toBe(100)
    for (const v of p) expect(Number.isFinite(v)).toBe(true)
  })

  it('stipples 4000 dots on 1024x768 with 20 iterations quickly', () => {
    const img = grayImage(1024, 768, (x, y) => 0.5 + 0.5 * Math.sin(x / 80) * Math.cos(y / 60))
    // Calibrate against the cheapest possible Lloyd loop (touch every pixel once per iteration) so the
    // check holds on slow or loaded machines.
    const n = img.data.length
    const acc = new Float64Array(4000)
    const b0 = performance.now()
    for (let it = 0; it < 20; it++) {
      for (let i = 0; i < n; i++) {
        const d = 1 - img.data[i]
        acc[((i >> 4) * 7) % 4000] += d * (i & 1023)
      }
    }
    const baseMs = performance.now() - b0
    const t0 = performance.now()
    const p = stipple(img, null, { count: 4000, iterations: 20, seed: 1 })
    const ms = performance.now() - t0
    expect(p.length).toBe(8000)
    expect(ms).toBeLessThan(Math.max(2000, 30 * baseMs))
  }, 30000)
})

describe('tourPoints', () => {
  it('handles tiny inputs', () => {
    expect(tourPoints(new Float32Array(0)).points.length).toBe(0)
    const one = tourPoints(new Float32Array([3, 4]))
    expect(Array.from(one.points)).toEqual([3, 4])
    expect(Array.from(one.jump)).toEqual([0])
    const three = tourPoints(new Float32Array([0, 0, 1, 0, 0, 1]))
    expect(pointKeys(three.points)).toEqual(pointKeys(new Float32Array([0, 0, 1, 0, 0, 1])))
  })

  it('handles duplicate and collinear points', () => {
    const p = new Float32Array([0, 0, 0, 0, 5, 0, 2, 0, 2, 0, 9, 0, 1, 0, 7, 0])
    const t = tourPoints(p)
    expect(pointKeys(t.points)).toEqual(pointKeys(p))
    expect(tourLength(t.points)).toBeCloseTo(18)
  })

  it('visits every point exactly once with no jumps', () => {
    const p = randomPoints(2000, 9)
    const t = tourPoints(p)
    expect(t.points.length).toBe(p.length)
    expect(t.jump.length).toBe(2000)
    expect(t.jump.every((v) => v === 0)).toBe(true)
    expect(pointKeys(t.points)).toEqual(pointKeys(p))
  })

  it('2-opt improves on the nearest-neighbor tour', () => {
    const p = randomPoints(1500, 11)
    const nn = tourLength(tourPoints(p, 0).points)
    const opt = tourLength(tourPoints(p, 1000).points)
    expect(opt).toBeLessThan(nn * 0.95)
  }, 30000)

  it('solves a convex polygon optimally', () => {
    const n = 200
    const p = new Float32Array(n * 2)
    // Points on a circle in shuffled order.
    const order = Array.from({ length: n }, (_, i) => (i * 73) % n)
    for (let i = 0; i < n; i++) {
      const a = (order[i] / n) * 2 * Math.PI
      p[2 * i] = 100 + 50 * Math.cos(a)
      p[2 * i + 1] = 100 + 50 * Math.sin(a)
    }
    const perimeter = n * 2 * 50 * Math.sin(Math.PI / n)
    expect(tourLength(tourPoints(p).points)).toBeCloseTo(perimeter, 1)
  })

  it('tours 5000 points in under 2 seconds', () => {
    const p = randomPoints(5000, 21)
    const t0 = performance.now()
    const t = tourPoints(p)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(2000)
    expect(pointKeys(t.points)).toEqual(pointKeys(p))
  }, 30000)
})
