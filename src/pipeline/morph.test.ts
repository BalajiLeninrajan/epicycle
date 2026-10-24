import { describe, expect, it } from 'vitest'
import { and, close, dilate, erode, fillHoles, removeSmallComponents, threshold } from './morph'
import type { BinaryImage, GrayImage } from './types'

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

/** Brute-force reference: O(r^2) per pixel disk dilation, ignoring pixels outside the image. */
function refDilate(b: BinaryImage, r: number): BinaryImage {
  const { width: w, height: h } = b
  const ri = Math.ceil(r)
  return bin(w, h, (x, y) => {
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy > r * r) continue
        const sx = x + dx
        const sy = y + dy
        if (sx >= 0 && sy >= 0 && sx < w && sy < h && b.data[sy * w + sx]) return true
      }
    }
    return false
  })
}

function invert(b: BinaryImage): BinaryImage {
  return { width: b.width, height: b.height, data: b.data.map((v) => v ^ 1) }
}

function noise(w: number, h: number, p: number, seed: number): BinaryImage {
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  return bin(w, h, () => rand() < p)
}

describe('threshold', () => {
  it('splits at t, inclusive above, and inverts', () => {
    const g: GrayImage = { width: 4, height: 1, data: new Float32Array([0, 0.49, 0.5, 1]) }
    expect([...threshold(g, 0.5).data]).toEqual([0, 0, 1, 1])
    expect([...threshold(g, 0.5, true).data]).toEqual([1, 1, 0, 0])
  })
})

describe('dilate / erode', () => {
  it('dilates a single pixel into an exact disk', () => {
    for (const r of [1, 1.5, 2, 3, 5, 7.3]) {
      const b = bin(21, 21, (x, y) => x === 10 && y === 10)
      expect(dilate(b, r).data).toEqual(refDilate(b, r).data)
    }
  })

  it('matches brute force on random noise for many radii', () => {
    const b = noise(53, 41, 0.02, 7)
    for (const r of [1, 2, 3.5, 6, 10, 15]) {
      expect(dilate(b, r).data).toEqual(refDilate(b, r).data)
      expect(erode(invert(b), r).data).toEqual(invert(refDilate(b, r)).data)
    }
  })

  it('returns copies for r < 1 and handles empty images', () => {
    const b = noise(10, 10, 0.5, 3)
    const d = dilate(b, 0)
    expect(d.data).toEqual(b.data)
    expect(d.data).not.toBe(b.data)
    expect(erode(b, 0.5).data).toEqual(b.data)
    expect(count(dilate(bin(10, 10, () => false), 4))).toBe(0)
    expect(count(erode(bin(10, 10, () => true), 4))).toBe(100)
    expect(dilate(bin(0, 0, () => true), 3).data.length).toBe(0)
  })

  it('erodes a rectangle by r but keeps sides that touch the border', () => {
    const b = bin(40, 30, (x, y) => x < 25 && y >= 5)
    const e = erode(b, 3)
    expect(e.data).toEqual(bin(40, 30, (x, y) => x < 22 && y >= 8).data)
  })

  it('erodes a circle to a smaller circle', () => {
    const b = bin(61, 61, (x, y) => Math.hypot(x - 30, y - 30) <= 20)
    const e = erode(b, 5)
    for (let y = 0; y < 61; y++) {
      for (let x = 0; x < 61; x++) {
        const d = Math.hypot(x - 30, y - 30)
        if (d <= 14) expect(e.data[y * 61 + x]).toBe(1)
        if (d > 15.5) expect(e.data[y * 61 + x]).toBe(0)
      }
    }
  })

  it('is fast for large radii', () => {
    const b = noise(1024, 1024, 0.001, 11)
    const t0 = performance.now()
    dilate(b, 15)
    erode(b, 15)
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})

describe('close', () => {
  it('bridges a narrow gap and fills small holes, but keeps the outline', () => {
    const b = bin(50, 30, (x, y) => y >= 10 && y < 20 && ((x >= 5 && x < 23) || (x >= 26 && x < 45)) && !(x === 10 && y === 15))
    const c = close(b, 3)
    for (let x = 5; x < 45; x++) expect(c.data[15 * 50 + x]).toBe(1)
    expect(c.data[15 * 50 + 10]).toBe(1)
    expect(c.data[5 * 50 + 25]).toBe(0)
    expect(c.data[15 * 50 + 2]).toBe(0)
  })

  it('leaves a convex shape touching the border unchanged', () => {
    const b = bin(30, 30, (x, y) => x < 12 && y < 20)
    expect(close(b, 5).data).toEqual(b.data)
  })
})

describe('removeSmallComponents', () => {
  it('drops small 8-connected blobs and keeps large ones', () => {
    const b = bin(30, 30, (x, y) => {
      if (x >= 2 && x < 12 && y >= 2 && y < 12) return true // 100 px
      if (x === 20 && y === 20) return true // 1 px
      return x + y === 50 && x >= 22 // diagonal line, 8-connected, 8 px
    })
    const out = removeSmallComponents(b, 5)
    expect(count(out)).toBe(108)
    expect(out.data[20 * 30 + 20]).toBe(0)
    const out2 = removeSmallComponents(b, 9)
    expect(count(out2)).toBe(100)
    expect(removeSmallComponents(b, 101).data.every((v) => v === 0)).toBe(true)
  })

  it('counts components across image borders and corners', () => {
    const b = bin(5, 5, (x, y) => (x === 0 && y === 0) || (x === 4 && y === 4) || (x === 3 && y === 4))
    const out = removeSmallComponents(b, 2)
    expect([...out.data].reduce((a, v) => a + v, 0)).toBe(2)
    expect(out.data[0]).toBe(0)
    expect(out.data[24]).toBe(1)
  })

  it('handles empty input and minArea <= 1', () => {
    expect(removeSmallComponents(bin(0, 0, () => true), 10).data.length).toBe(0)
    const b = noise(20, 20, 0.3, 5)
    expect(removeSmallComponents(b, 1).data).toEqual(b.data)
  })

  it('on noise, keeps only components at least minArea', () => {
    const b = noise(100, 100, 0.35, 9)
    const out = removeSmallComponents(b, 10)
    expect(count(out)).toBeLessThan(count(b))
    // Kept pixels are a subset and applying it again changes nothing.
    for (let i = 0; i < b.data.length; i++) expect(out.data[i] <= b.data[i]).toBe(true)
    expect(removeSmallComponents(out, 10).data).toEqual(out.data)
  })
})

describe('fillHoles', () => {
  it('fills enclosed regions of a ring', () => {
    const b = bin(40, 40, (x, y) => {
      const d = Math.hypot(x - 20, y - 20)
      return d >= 10 && d <= 13
    })
    const out = fillHoles(b)
    expect(out.data).toEqual(bin(40, 40, (x, y) => Math.hypot(x - 20, y - 20) <= 13).data)
  })

  it('does not fill regions open to the border', () => {
    // U shape opening to the top edge.
    const b = bin(20, 20, (x, y) => (x === 5 || x === 14 || y === 15) && x >= 5 && x <= 14 && y <= 15)
    expect(fillHoles(b).data).toEqual(b.data)
  })

  it('does not leak through a diagonal (8-connected) wall', () => {
    const b = bin(9, 9, (x, y) => Math.abs(x - 4) + Math.abs(y - 4) === 3)
    const out = fillHoles(b)
    expect(out.data).toEqual(bin(9, 9, (x, y) => Math.abs(x - 4) + Math.abs(y - 4) <= 3).data)
  })

  it('handles all-foreground, all-background and empty images', () => {
    expect(count(fillHoles(bin(5, 5, () => true)))).toBe(25)
    expect(count(fillHoles(bin(5, 5, () => false)))).toBe(0)
    expect(fillHoles(bin(0, 0, () => false)).data.length).toBe(0)
  })
})

describe('and', () => {
  it('intersects and rejects mismatched sizes', () => {
    const a = bin(3, 1, (x) => x > 0)
    const b = bin(3, 1, (x) => x < 2)
    expect([...and(a, b).data]).toEqual([0, 1, 0])
    expect(() => and(a, bin(1, 3, () => true))).toThrow()
  })
})
