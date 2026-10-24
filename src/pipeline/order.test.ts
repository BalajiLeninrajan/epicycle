import { describe, expect, it } from 'vitest'
import { orderStrokes } from './order'
import type { Polyline, SinglePath } from './types'

const poly = (xy: number[]): Polyline => new Float32Array(xy)

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function randomStrokes(count: number, seed: number, closedEvery = 0): Polyline[] {
  const r = rng(seed)
  const out: Polyline[] = []
  for (let i = 0; i < count; i++) {
    const x = r() * 1000
    const y = r() * 1000
    if (closedEvery && i % closedEvery === 0) {
      const rad = 3 + r() * 10
      const n = 5 + Math.floor(r() * 6)
      const xy: number[] = []
      for (let k = 0; k < n; k++) xy.push(x + rad * Math.cos((2 * Math.PI * k) / n), y + rad * Math.sin((2 * Math.PI * k) / n))
      xy.push(xy[0], xy[1])
      out.push(poly(xy))
    } else {
      const n = 2 + Math.floor(r() * 4)
      const xy = [x, y]
      for (let k = 1; k < n; k++) xy.push(xy[2 * k - 2] + (r() - 0.5) * 20, xy[2 * k - 1] + (r() - 0.5) * 20)
      out.push(poly(xy))
    }
  }
  return out
}

function segLen(p: SinglePath, i: number): number {
  const c = p.jump.length
  const j = i + 1 === c ? 0 : i + 1
  return Math.hypot(p.points[2 * j] - p.points[2 * i], p.points[2 * j + 1] - p.points[2 * i + 1])
}

function jumpLength(p: SinglePath): number {
  let t = 0
  for (let i = 0; i < p.jump.length; i++) if (p.jump[i]) t += segLen(p, i)
  return t
}

/** Every non-jump segment is a stroke segment and every stroke segment is drawn exactly once. */
function checkCoverage(strokes: Polyline[], p: SinglePath): void {
  const key = (x0: number, y0: number, x1: number, y1: number): string =>
    x0 < x1 || (x0 === x1 && y0 <= y1) ? `${x0},${y0},${x1},${y1}` : `${x1},${y1},${x0},${y0}`
  const want = new Map<string, number>()
  for (const s of strokes) {
    for (let i = 0; i + 3 < s.length; i += 2) {
      if (s[i] === s[i + 2] && s[i + 1] === s[i + 3]) continue
      const k = key(s[i], s[i + 1], s[i + 2], s[i + 3])
      want.set(k, (want.get(k) ?? 0) + 1)
    }
  }
  const c = p.jump.length
  expect(p.points.length).toBe(2 * c)
  for (let i = 0; i < c; i++) {
    if (p.jump[i]) continue
    const j = i + 1 === c ? 0 : i + 1
    const x0 = p.points[2 * i]
    const y0 = p.points[2 * i + 1]
    const x1 = p.points[2 * j]
    const y1 = p.points[2 * j + 1]
    if (x0 === x1 && y0 === y1) continue
    const k = key(x0, y0, x1, y1)
    const left = want.get(k)
    expect(left, `segment ${k} is not a stroke segment`).toBeGreaterThan(0)
    want.set(k, left! - 1)
  }
  for (const [k, v] of want) expect(v, `segment ${k} missing`).toBe(0)
}

describe('orderStrokes', () => {
  it('returns empty arrays for empty input', () => {
    for (const input of [[], [poly([])], [poly([1])]]) {
      const p = orderStrokes(input)
      expect(p.points.length).toBe(0)
      expect(p.jump.length).toBe(0)
    }
  })

  it('returns a single open stroke unchanged with only the closing jump', () => {
    const s = poly([0, 0, 5, 1, 9, 4])
    const p = orderStrokes([s])
    expect(Array.from(p.points)).toEqual(Array.from(s))
    expect(Array.from(p.jump)).toEqual([0, 0, 1])
  })

  it('returns a single closed stroke unchanged with no jumps', () => {
    const s = poly([0, 0, 10, 0, 10, 10, 0, 0])
    const p = orderStrokes([s])
    expect(Array.from(p.points)).toEqual(Array.from(s))
    expect(Array.from(p.jump)).toEqual([0, 0, 0, 0])
  })

  it('handles a single-point stroke', () => {
    const p = orderStrokes([poly([3, 4])])
    expect(Array.from(p.points)).toEqual([3, 4])
    expect(Array.from(p.jump)).toEqual([0])
  })

  it('reverses the points of a stroke walked backwards', () => {
    const p = orderStrokes([poly([0, 0, 10, 0]), poly([20, 0, 15, 0, 11, 0])])
    expect(Array.from(p.points)).toEqual([0, 0, 10, 0, 11, 0, 15, 0, 20, 0])
    expect(Array.from(p.jump)).toEqual([0, 1, 0, 0, 1])
  })

  it('joins touching strokes without a jump or duplicate point', () => {
    const p = orderStrokes([poly([0, 0, 10, 0]), poly([10, 10, 10, 0])])
    expect(Array.from(p.points)).toEqual([0, 0, 10, 0, 10, 10])
    expect(Array.from(p.jump)).toEqual([0, 0, 1])
  })

  it('enters a closed loop at its nearest vertex and leaves from the same vertex', () => {
    const line = poly([0, 0, 10, 0])
    const diamond = poly([25, 0, 20, -5, 15, 0, 20, 5, 25, 0])
    for (const opts of [{ maxPasses: 0 }, {}]) {
      const p = orderStrokes([line, diamond], opts)
      expect(Array.from(p.points)).toEqual([0, 0, 10, 0, 15, 0, 20, 5, 25, 0, 20, -5, 15, 0])
      expect(Array.from(p.jump)).toEqual([0, 1, 0, 0, 0, 0, 1])
    }
  })

  it('keeps closed loops intact between open strokes', () => {
    const strokes = [poly([0, 0, 10, 0]), poly([12, 0, 14, 2, 16, 0, 14, -2, 12, 0]), poly([30, 0, 18, 0])]
    const p = orderStrokes(strokes)
    checkCoverage(strokes, p)
  })

  it('draws every stroke segment exactly once', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const strokes = randomStrokes(300, seed, 4)
      checkCoverage(strokes, orderStrokes(strokes))
      checkCoverage(strokes, orderStrokes(strokes, { maxPasses: 0 }))
    }
  })

  it('never makes total jump length worse than nearest neighbor', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const strokes = randomStrokes(20 + seed * 30, seed * 7919, seed % 3 === 0 ? 3 : 0)
      const nn = jumpLength(orderStrokes(strokes, { maxPasses: 0 }))
      const opt = jumpLength(orderStrokes(strokes))
      expect(opt).toBeLessThanOrEqual(nn + 1e-6)
    }
  })

  it('improves on nearest neighbor for a random set', () => {
    const strokes = randomStrokes(800, 42)
    const nn = jumpLength(orderStrokes(strokes, { maxPasses: 0 }))
    const opt = jumpLength(orderStrokes(strokes))
    expect(opt).toBeLessThan(nn * 0.95)
  })

  it('finds the obvious tour for a row of segments given in shuffled order', () => {
    // Optimal: walk right along the row, one long jump back. Total jump = 9*1 + (10*10-1).
    const order = [7, 2, 9, 0, 5, 3, 8, 1, 6, 4]
    const strokes = order.map((i) => (i % 2 ? poly([i * 10 + 9, 0, i * 10, 0]) : poly([i * 10, 0, i * 10 + 9, 0])))
    const p = orderStrokes(strokes)
    checkCoverage(strokes, p)
    expect(jumpLength(p)).toBeCloseTo(9 + 99, 6)
  })

  it('handles coincident and collinear inputs without NaN', () => {
    const same = Array.from({ length: 50 }, () => poly([5, 5]))
    const p = orderStrokes(same)
    expect(Array.from(p.points)).toEqual([5, 5])
    expect(Array.from(p.jump)).toEqual([0])

    const line = Array.from({ length: 100 }, (_, i) => poly([i * 3, 7, i * 3 + 1, 7]))
    const q = orderStrokes(line)
    checkCoverage(line, q)
    expect(Array.from(q.points).every(Number.isFinite)).toBe(true)
    expect(jumpLength(q)).toBeCloseTo(99 * 2 + 298, 4)
  })

  it('handles strokes at image borders and negative coordinates', () => {
    const strokes = [poly([0, 0, 0, 100]), poly([-5, 50, -5, 60]), poly([1023, 0, 1023, 767]), poly([1023, 767, 0, 767])]
    checkCoverage(strokes, orderStrokes(strokes))
  })

  it('orders 2000 random short strokes in under a second', () => {
    const strokes = randomStrokes(2000, 123, 5)
    const t0 = performance.now()
    const p = orderStrokes(strokes)
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(1000)
    checkCoverage(strokes, p)
  })

  it('respects the time budget on large inputs', () => {
    const strokes = randomStrokes(20000, 9)
    const t0 = performance.now()
    orderStrokes(strokes, { timeBudgetMs: 50 })
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
