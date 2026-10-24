import { describe, expect, it } from 'vitest'
import { cleanStrokes, polylineLength, rdp, traceSkeleton } from './trace'
import type { BinaryImage, Polyline } from './types'

function img(w: number, h: number, pixels: [number, number][]): BinaryImage {
  const data = new Uint8Array(w * h)
  for (const [x, y] of pixels) data[y * w + x] = 1
  return { width: w, height: h, data }
}

function line(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = []
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  for (let i = 0; i <= n; i++) {
    out.push([x0 + Math.round(((x1 - x0) * i) / n), y0 + Math.round(((y1 - y0) * i) / n)])
  }
  return out
}

/** 4-connected inner boundary of a filled disk: a closed 1px ring. */
function ring(cx: number, cy: number, r: number): [number, number][] {
  const inside = (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  const out: [number, number][] = []
  for (let y = cy - r - 1; y <= cy + r + 1; y++) {
    for (let x = cx - r - 1; x <= cx + r + 1; x++) {
      if (!inside(x, y)) continue
      if (!inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1)) out.push([x, y])
    }
  }
  return out
}

const first = (p: Polyline) => [p[0], p[1]]
const last = (p: Polyline) => [p[p.length - 2], p[p.length - 1]]
const isClosed = (p: Polyline) => p.length >= 4 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1]

/** The endpoint every polyline has in common, as "x,y", or null. */
function sharedEnd(polys: Polyline[]): string | null {
  const ends = polys.map((p) => [String(first(p)), String(last(p))])
  return ends[0].find((e) => ends.every((pair) => pair.includes(e))) ?? null
}

/** For each polyline, the endpoint that is not `shared`. */
const otherEnds = (polys: Polyline[], shared: string) =>
  polys.map((p) => (String(first(p)) === shared ? String(last(p)) : String(first(p)))).sort()

/** Every skeleton pixel lies within maxDist of some polyline vertex. */
function expectCovered(im: BinaryImage, polys: Polyline[], maxDist = 0) {
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      if (!im.data[y * im.width + x]) continue
      let best = Infinity
      for (const p of polys) {
        for (let i = 0; i < p.length; i += 2) best = Math.min(best, Math.hypot(p[i] - x, p[i + 1] - y))
      }
      expect(best, `pixel ${x},${y}`).toBeLessThanOrEqual(maxDist)
    }
  }
}

/** Every consecutive vertex pair is at most one pixel step apart. */
function expectContinuous(polys: Polyline[]) {
  for (const p of polys) {
    for (let i = 2; i < p.length; i += 2) {
      expect(Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])).toBeLessThanOrEqual(Math.SQRT2 + 1e-6)
    }
  }
}

describe('traceSkeleton', () => {
  it('returns nothing for an empty image', () => {
    expect(traceSkeleton(img(10, 10, []))).toEqual([])
    expect(traceSkeleton({ width: 0, height: 0, data: new Uint8Array(0) })).toEqual([])
  })

  it('turns an isolated pixel into a 1-point polyline, including at a corner', () => {
    const out = traceSkeleton(img(5, 5, [[0, 0], [4, 4]]))
    expect(out.map((p) => Array.from(p)).sort()).toEqual([
      [0, 0],
      [4, 4],
    ])
  })

  it('traces a straight line as one open stroke', () => {
    const im = img(20, 5, line(0, 2, 19, 2))
    const out = traceSkeleton(im)
    expect(out).toHaveLength(1)
    expect(out[0].length / 2).toBe(20)
    const ends = [first(out[0]), last(out[0])].sort((a, b) => a[0] - b[0])
    expect(ends).toEqual([
      [0, 2],
      [19, 2],
    ])
    expect(polylineLength(out[0])).toBeCloseTo(19)
  })

  it('traces diagonal and staircase lines without spurious junctions', () => {
    const diag = img(12, 12, line(0, 0, 11, 11))
    expect(traceSkeleton(diag)).toHaveLength(1)
    // 4-connected staircase: corner pixels create diagonal shortcuts that must be ignored.
    const stairs: [number, number][] = []
    for (let i = 0; i < 6; i++) stairs.push([i, i], [i + 1, i])
    const out = traceSkeleton(img(10, 10, stairs))
    expect(out).toHaveLength(1)
    expect(out[0].length / 2).toBe(stairs.length)
  })

  it('splits a plus sign into 4 strokes meeting at one junction', () => {
    const im = img(21, 21, [...line(2, 10, 18, 10), ...line(10, 2, 10, 18)])
    const out = traceSkeleton(im)
    expect(out).toHaveLength(4)
    expect(sharedEnd(out)).toBe('10,10')
    expect(otherEnds(out, '10,10')).toEqual(['10,18', '10,2', '18,10', '2,10'])
    for (const p of out) expect(polylineLength(p)).toBeCloseTo(8)
    expectCovered(im, out)
    expectContinuous(out)
  })

  it('splits a Y into 3 strokes sharing the junction point', () => {
    const im = img(20, 20, [...line(10, 10, 10, 19), ...line(10, 10, 3, 3), ...line(10, 10, 17, 3)])
    const out = traceSkeleton(im)
    expect(out).toHaveLength(3)
    expect(sharedEnd(out)).toBe('10,10')
    expect(otherEnds(out, '10,10')).toEqual(['10,19', '17,3', '3,3'])
    expectCovered(im, out)
    expectContinuous(out)
  })

  it('traces a ring as one closed loop', () => {
    const im = img(30, 30, ring(15, 15, 10))
    const out = traceSkeleton(im)
    expect(out).toHaveLength(1)
    expect(isClosed(out[0])).toBe(true)
    expect(out[0].length / 2 - 1).toBe(ring(15, 15, 10).length)
    expectCovered(im, out)
    expectContinuous(out)
  })

  it('traces a rectangle outline touching the image border as one closed loop', () => {
    const px: [number, number][] = []
    for (let x = 0; x < 8; x++) px.push([x, 0], [x, 5])
    for (let y = 1; y < 5; y++) px.push([0, y], [7, y])
    const out = traceSkeleton(img(8, 6, px))
    expect(out).toHaveLength(1)
    expect(isClosed(out[0])).toBe(true)
    expect(polylineLength(out[0])).toBeCloseTo(2 * (7 + 5))
  })

  it('keeps disconnected shapes separate', () => {
    const im = img(40, 30, [...line(1, 1, 1, 20), ...ring(25, 15, 8)])
    const out = traceSkeleton(im)
    expect(out).toHaveLength(2)
    expect(out.filter(isClosed)).toHaveLength(1)
    expectCovered(im, out)
  })

  it('collapses a 2x2 block on a line into one junction instead of a tiny loop', () => {
    const im = img(21, 8, [...line(0, 4, 20, 4), [10, 5], [11, 5]])
    const out = traceSkeleton(im)
    expect(out).toHaveLength(2)
    for (const p of out) expect(isClosed(p)).toBe(false)
    expect(sharedEnd(out)).toBe('10.5,4.5')
    expectCovered(im, out, 1)
  })

  it('merges a thick T junction into one node', () => {
    // Extra pixel at (6,1) makes a 2x2 block with the bar and the stem.
    const im = img(13, 10, [...line(0, 0, 12, 0), ...line(5, 1, 5, 9), [6, 1]])
    const out = traceSkeleton(im)
    expect(out).toHaveLength(3)
    expect(sharedEnd(out)).toBe('5.5,0.5')
    expect(otherEnds(out, '5.5,0.5')).toEqual(['0,0', '12,0', '5,9'])
    for (const p of out) expect(isClosed(p)).toBe(false)
    expectCovered(im, out, 1)
  })

  it('keeps a loop hanging off a stroke as a closed polyline from the junction', () => {
    // A square loop with a tail leaving its bottom-left corner.
    const px: [number, number][] = []
    for (let i = 0; i <= 6; i++) px.push([5 + i, 5], [5 + i, 11], [5, 5 + i], [11, 5 + i])
    px.push(...line(4, 12, 0, 16))
    const out = traceSkeleton(img(20, 20, px))
    expect(out).toHaveLength(2)
    expect(out.filter(isClosed)).toHaveLength(1)
    expectContinuous(out)
  })
})

describe('rdp', () => {
  it('reduces a straight line to its endpoints', () => {
    const p = new Float32Array([0, 0, 1, 0, 2, 0, 3, 0, 4, 0])
    expect(Array.from(rdp(p, 0.1))).toEqual([0, 0, 4, 0])
  })

  it('keeps corners above epsilon and drops noise below it', () => {
    const p = new Float32Array([0, 0, 1, 0.1, 2, 0, 3, 0.05, 4, 0, 4, 1, 4, 2, 4, 3])
    expect(Array.from(rdp(p, 0.5))).toEqual([0, 0, 4, 0, 4, 3])
  })

  it('leaves 0, 1 and 2 point polylines alone', () => {
    for (const a of [[], [1, 2], [1, 2, 3, 4]]) {
      expect(Array.from(rdp(new Float32Array(a), 1))).toEqual(a)
    }
  })

  it('does not collapse a closed loop', () => {
    const n = 64
    const p = new Float32Array(2 * (n + 1))
    for (let i = 0; i <= n; i++) {
      p[2 * i] = 10 * Math.cos((2 * Math.PI * i) / n)
      p[2 * i + 1] = 10 * Math.sin((2 * Math.PI * i) / n)
    }
    p[2 * n] = p[0]
    p[2 * n + 1] = p[1]
    const s = rdp(p, 0.5)
    expect(s.length / 2).toBeGreaterThan(5)
    expect(isClosed(s)).toBe(true)
    // A huge epsilon still leaves a triangle.
    const t = rdp(p, 100)
    expect(t.length / 2).toBe(4)
    expect(isClosed(t)).toBe(true)
  })

  it('handles long inputs without recursion', () => {
    const n = 5000
    const p = new Float32Array(2 * n)
    for (let i = 0; i < n; i++) {
      p[2 * i] = i
      p[2 * i + 1] = i % 2
    }
    expect(rdp(p, 0.1).length / 2).toBe(n)
    expect(rdp(p, 2).length / 2).toBe(2)
  })
})

describe('polylineLength', () => {
  it('sums segment lengths', () => {
    expect(polylineLength(new Float32Array([0, 0, 3, 4, 3, 10]))).toBeCloseTo(11)
    expect(polylineLength(new Float32Array([5, 5]))).toBe(0)
    expect(polylineLength(new Float32Array(0))).toBe(0)
  })
})

describe('cleanStrokes', () => {
  it('drops short strokes and simplifies the rest', () => {
    const short = new Float32Array([0, 0, 1, 0])
    const dot = new Float32Array([3, 3])
    const long = new Float32Array([0, 0, 1, 0, 2, 0, 3, 0, 10, 0])
    const out = cleanStrokes([short, dot, long], 2, 0.5)
    expect(out).toHaveLength(1)
    expect(Array.from(out[0])).toEqual([0, 0, 10, 0])
  })

  it('works on traced skeletons end to end', () => {
    const im = img(21, 21, [...line(2, 10, 18, 10), ...line(10, 2, 10, 18), [0, 0]])
    const out = cleanStrokes(traceSkeleton(im), 3, 0.5)
    expect(out).toHaveLength(4)
    for (const p of out) expect(p.length).toBe(4)
  })
})
