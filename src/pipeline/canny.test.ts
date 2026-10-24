import { describe, expect, it } from 'vitest'
import { canny } from './canny'
import type { BinaryImage, GrayImage } from './types'

function gray(width: number, height: number, fn: (x: number, y: number) => number): GrayImage {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y)
  return { width, height, data }
}

function count(b: BinaryImage): number {
  let n = 0
  for (const v of b.data) n += v
  return n
}

const opts = { sigma: 1, low: 0.1, high: 0.3 }

describe('canny', () => {
  it('returns no edges for flat and empty images', () => {
    expect(count(canny(gray(20, 20, () => 0.5), opts))).toBe(0)
    expect(canny(gray(0, 0, () => 0), opts).data.length).toBe(0)
    expect(count(canny(gray(1, 1, () => 1), opts))).toBe(0)
    expect(count(canny(gray(2, 5, (x) => x), opts))).toBe(0)
  })

  it('traces a filled rectangle with a thin closed outline', () => {
    const w = 60
    const h = 50
    const img = gray(w, h, (x, y) => (x >= 15 && x < 45 && y >= 10 && y < 40 ? 0 : 1))
    const e = canny(img, opts)
    const at = (x: number, y: number) => e.data[y * w + x]
    // Every edge pixel sits within a pixel of the true boundary.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!at(x, y)) continue
        const dx = Math.min(Math.abs(x - 14.5), Math.abs(x - 44.5))
        const dy = Math.min(Math.abs(y - 9.5), Math.abs(y - 39.5))
        const nearV = dx <= 1 && y >= 8 && y <= 41
        const nearH = dy <= 1 && x >= 13 && x <= 46
        expect(nearV || nearH).toBe(true)
      }
    }
    // Each side is found, and NMS keeps it one pixel thick.
    for (let y = 15; y < 35; y++) {
      let left = 0
      for (let x = 10; x < 20; x++) left += at(x, y)
      expect(left).toBe(1)
    }
    for (let x = 20; x < 40; x++) {
      let top = 0
      for (let y = 5; y < 15; y++) top += at(x, y)
      expect(top).toBe(1)
    }
    // Interior and far background stay empty.
    expect(at(30, 25)).toBe(0)
    expect(at(2, 2)).toBe(0)
  })

  it('finds a circle outline with no gaps along it', () => {
    const w = 80
    const img = gray(w, w, (x, y) => (Math.hypot(x - 40, y - 40) < 25 ? 1 : 0))
    const e = canny(img, opts)
    let hits = 0
    for (let a = 0; a < 360; a += 5) {
      const t = (a * Math.PI) / 180
      let found = false
      for (let r = 23; r <= 27 && !found; r += 0.5) {
        const x = Math.round(40 + r * Math.cos(t))
        const y = Math.round(40 + r * Math.sin(t))
        if (e.data[y * w + x]) found = true
      }
      if (found) hits++
    }
    expect(hits).toBe(72)
    // Thin: total edge pixels close to the circumference.
    const n = count(e)
    expect(n).toBeGreaterThan(2 * Math.PI * 25 * 0.8)
    expect(n).toBeLessThan(2 * Math.PI * 25 * 1.6)
  })

  it('uses hysteresis to keep weak edges connected to strong ones', () => {
    // A step whose contrast fades along its length: strong at the top, weak at the bottom.
    const w = 40
    const h = 60
    const img = gray(w, h, (x, y) => (x < 20 ? 0 : 1 - (y / h) * 0.85))
    const lowOnly = canny(img, { sigma: 1, low: 0.1, high: 0.9 })
    const at = (y: number) => {
      let s = 0
      for (let x = 15; x < 25; x++) s += lowOnly.data[y * w + x]
      return s
    }
    // Rows near the bottom are below `high` but connected to the strong part.
    expect(at(5)).toBe(1)
    expect(at(50)).toBe(1)
    // An isolated weak edge with no strong seed is dropped.
    const weak = gray(w, h, (x, y) => (y < 30 ? (x < 20 ? 0 : 1) : x < 20 ? 0.45 : 0.55))
    const e = canny(weak, { sigma: 1, low: 0.05, high: 0.5 })
    let top = 0
    let bottom = 0
    for (let y = 0; y < 25; y++) for (let x = 0; x < w; x++) top += e.data[y * w + x]
    for (let y = 36; y < h; y++) for (let x = 0; x < w; x++) bottom += e.data[y * w + x]
    expect(top).toBeGreaterThan(20)
    // The weak part is attached to the strong part, so it survives too.
    expect(bottom).toBeGreaterThan(20)
    const detached = gray(w, h, (x, y) => (y < 25 ? (x < 10 ? 0 : 1) : x < 30 ? 0.45 : 0.55))
    const d = canny(detached, { sigma: 1, low: 0.05, high: 0.5 })
    let weakSide = 0
    for (let y = 30; y < h - 2; y++) for (let x = 25; x < 35; x++) weakSide += d.data[y * w + x]
    expect(weakSide).toBe(0)
  })

  it('handles shapes touching the image border', () => {
    const w = 30
    const img = gray(w, w, (x) => (x < 10 ? 1 : 0))
    const e = canny(img, opts)
    expect(count(e)).toBeGreaterThan(0)
    for (let y = 0; y < w; y++) {
      expect(e.data[y * w]).toBe(0)
      expect(e.data[y * w + w - 1]).toBe(0)
    }
  })

  it('ignores low-amplitude noise relative to a strong edge', () => {
    let seed = 1
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const w = 64
    const img = gray(w, w, (x) => (x < 32 ? 0.2 : 0.8) + (rand() - 0.5) * 0.05)
    const e = canny(img, { sigma: 1.5, low: 0.2, high: 0.4 })
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) if (e.data[y * w + x]) expect(Math.abs(x - 31.5)).toBeLessThanOrEqual(1.5)
    }
  })
})
