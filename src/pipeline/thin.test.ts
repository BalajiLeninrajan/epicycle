import { describe, expect, it } from 'vitest'
import { zhangSuen } from './thin'
import type { BinaryImage } from './types'

function bin(width: number, height: number, fn: (x: number, y: number) => boolean): BinaryImage {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y) ? 1 : 0
  return { width, height, data }
}

function count(b: BinaryImage): number {
  let n = 0
  for (const v of b.data) n += v
  return n
}

function get(b: BinaryImage, x: number, y: number): number {
  return x >= 0 && y >= 0 && x < b.width && y < b.height ? b.data[y * b.width + x] : 0
}

/** Number of 8-connected foreground components. */
function components(b: BinaryImage): number {
  const { width: w, height: h } = b
  const seen = new Uint8Array(w * h)
  let n = 0
  const stack: number[] = []
  for (let s = 0; s < w * h; s++) {
    if (!b.data[s] || seen[s]) continue
    n++
    seen[s] = 1
    stack.push(s)
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (b.data[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
    }
  }
  return n
}

/** Number of 4-connected background components, counting the outside as one region. */
function bgComponents(b: BinaryImage): number {
  const w = b.width + 2
  const h = b.height + 2
  const pad = bin(w, h, (x, y) => get(b, x - 1, y - 1) === 0)
  const seen = new Uint8Array(w * h)
  let n = 0
  const stack: number[] = []
  for (let s = 0; s < w * h; s++) {
    if (!pad.data[s] || seen[s]) continue
    n++
    seen[s] = 1
    stack.push(s)
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i / w) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (pad.data[j] && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
  }
  return n
}

/** Whether clearing (x, y) changes the topology (brute force). */
function needed(s: BinaryImage, x: number, y: number): boolean {
  const t = { width: s.width, height: s.height, data: s.data.slice() }
  t.data[y * s.width + x] = 0
  return components(t) !== components(s) || bgComponents(t) !== bgComponents(s)
}

/**
 * 1px wide in the 8-connected sense: no 2x2 block (unless every pixel in it is
 * needed, as at an X junction of four diagonals) and no staircase corner, i.e. a
 * pixel with exactly two neighbors that are 4-neighbors at a right angle.
 */
function expectThin(s: BinaryImage): void {
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      if (!get(s, x, y)) continue
      const block = get(s, x + 1, y) && get(s, x, y + 1) && get(s, x + 1, y + 1)
      if (block) {
        const irreducible =
          needed(s, x, y) && needed(s, x + 1, y) && needed(s, x, y + 1) && needed(s, x + 1, y + 1)
        expect(irreducible, `2x2 block at ${x},${y}`).toBe(true)
      }
      let nb = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) nb += get(s, x + dx, y + dy)
      if (nb !== 2) continue
      const n = get(s, x, y - 1), e = get(s, x + 1, y), so = get(s, x, y + 1), w = get(s, x - 1, y)
      const corner = (n && e) || (e && so) || (so && w) || (w && n)
      expect(corner, `staircase corner at ${x},${y}`).toBeFalsy()
    }
  }
}

function expectSubset(s: BinaryImage, b: BinaryImage): void {
  for (let i = 0; i < b.data.length; i++) expect(s.data[i] <= b.data[i]).toBe(true)
}

function expectTopology(s: BinaryImage, b: BinaryImage): void {
  expect(components(s)).toBe(components(b))
  expect(bgComponents(s)).toBe(bgComponents(b))
}

function extent(s: BinaryImage): { w: number; h: number } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      if (!get(s, x, y)) continue
      x0 = Math.min(x0, x); x1 = Math.max(x1, x)
      y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

describe('zhangSuen', () => {
  it('handles empty input, a single pixel and isolated pixels', () => {
    expect(zhangSuen(bin(0, 0, () => true)).data.length).toBe(0)
    expect(count(zhangSuen(bin(10, 10, () => false)))).toBe(0)
    const one = bin(1, 1, () => true)
    expect([...zhangSuen(one).data]).toEqual([1])
    const dots = bin(9, 9, (x, y) => x % 4 === 0 && y % 4 === 0)
    expect(zhangSuen(dots).data).toEqual(dots.data)
  })

  it('leaves an existing 1px skeleton unchanged', () => {
    const plus = bin(15, 15, (x, y) => (x === 7 && y >= 2 && y <= 12) || (y === 7 && x >= 2 && x <= 12))
    expect(zhangSuen(plus).data).toEqual(plus.data)
    const diag = bin(12, 12, (x, y) => x === y)
    expect(zhangSuen(diag).data).toEqual(diag.data)
  })

  it('thins a thick horizontal bar to a centered line of nearly full length', () => {
    const b = bin(40, 20, (x, y) => x >= 5 && x < 35 && y >= 7 && y < 14)
    const s = zhangSuen(b)
    expectSubset(s, b)
    expectThin(s)
    expectTopology(s, b)
    const e = extent(s)
    expect(e.w).toBeGreaterThanOrEqual(22)
    // A short diagonal spur toward a corner is allowed, no longer than half the thickness.
    expect(e.h).toBeLessThanOrEqual(5)
    for (let x = 12; x < 28; x++) {
      let col = 0
      for (let y = 0; y < 20; y++) if (get(s, x, y)) {
        col++
        expect(Math.abs(y - 10)).toBeLessThanOrEqual(1)
      }
      expect(col).toBe(1)
    }
  })

  it('keeps short 2px-thick lines in every orientation', () => {
    const shapes: Array<[string, (x: number, y: number) => boolean]> = [
      ['2x2', (x, y) => x >= 5 && x < 7 && y >= 5 && y < 7],
      ['2x3 h', (x, y) => x >= 5 && x < 8 && y >= 5 && y < 7],
      ['2x3 v', (x, y) => x >= 5 && x < 7 && y >= 5 && y < 8],
      ['2x8 h', (x, y) => x >= 3 && x < 11 && y >= 5 && y < 7],
      ['2x8 v', (x, y) => x >= 5 && x < 7 && y >= 3 && y < 11],
      ['diag \\', (x, y) => x >= 3 && x < 11 && (y - x === 0 || y - x === 1)],
      ['diag /', (x, y) => x >= 3 && x < 11 && (x + y === 14 || x + y === 15)],
      ['L', (x, y) => (x >= 3 && x < 5 && y >= 3 && y < 11) || (y >= 9 && y < 11 && x >= 3 && x < 10)],
    ]
    for (const [name, fn] of shapes) {
      const b = bin(14, 14, fn)
      const s = zhangSuen(b)
      expect(count(s), name).toBeGreaterThan(0)
      expectSubset(s, b)
      expectThin(s)
      expectTopology(s, b)
      // The line keeps most of its length.
      const eb = extent(b)
      const es = extent(s)
      expect(Math.max(es.w, es.h), name).toBeGreaterThanOrEqual(Math.max(eb.w, eb.h) - 2)
    }
  })

  it('keeps a free-ended 2px diagonal stroke attached to a thick body', () => {
    const b = bin(40, 40, (x, y) => (y >= 30 && y < 35 && x >= 5 && x < 35) || (x >= 10 && x < 30 && (x + y === 40 || x + y === 41)))
    const s = zhangSuen(b)
    expectSubset(s, b)
    expectThin(s)
    expectTopology(s, b)
    // The stroke tip near (29, 11) survives.
    let tip = Infinity
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (get(s, x, y)) tip = Math.min(tip, y)
    expect(tip).toBeLessThanOrEqual(12)
  })

  it('reduces a thick ring to a closed 1px loop', () => {
    const b = bin(50, 50, (x, y) => {
      const d = Math.hypot(x - 25, y - 25)
      return d >= 12 && d <= 17
    })
    const s = zhangSuen(b)
    expectSubset(s, b)
    expectThin(s)
    expectTopology(s, b)
    // Nearly every pixel on the loop has exactly two neighbors. The rasterized
    // disk has one-pixel bumps at its extremes, which may leave a tiny spur.
    let odd = 0
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 50; x++) {
        if (!get(s, x, y)) continue
        let nb = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) nb += get(s, x + dx, y + dy)
        if (nb !== 2) odd++
        const d = Math.hypot(x - 25, y - 25)
        expect(d).toBeGreaterThan(12.5)
        expect(d).toBeLessThan(17.5)
      }
    }
    expect(odd).toBeLessThanOrEqual(4)
  })

  it('thins a filled rectangle to a connected skeleton', () => {
    const b = bin(30, 20, (x, y) => x >= 3 && x < 27 && y >= 3 && y < 17)
    const s = zhangSuen(b)
    expectSubset(s, b)
    expectThin(s)
    expectTopology(s, b)
    expect(count(s)).toBeLessThan(60)
    expect(count(s)).toBeGreaterThan(10)
  })

  it('handles shapes on the image border', () => {
    const b = bin(20, 10, (_, y) => y < 4)
    const s = zhangSuen(b)
    expectThin(s)
    expectTopology(s, b)
    expect(extent(s).w).toBeGreaterThanOrEqual(14)
    const full = bin(6, 6, () => true)
    const sf = zhangSuen(full)
    expect(count(sf)).toBeGreaterThan(0)
    expectThin(sf)
    expectTopology(sf, full)
  })

  it('preserves topology on random noise blobs', () => {
    let seed = 42
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let trial = 0; trial < 5; trial++) {
      const b = bin(60, 60, () => rand() < 0.55)
      const s = zhangSuen(b)
      expectSubset(s, b)
      expectThin(s)
      expectTopology(s, b)
    }
  })

  it('is fast on a large image of thick strokes', () => {
    const b = bin(1024, 1024, (x, y) => (x % 64 < 6) || (y % 80 < 5) || Math.abs(x - y) < 4)
    const t0 = performance.now()
    zhangSuen(b)
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})
