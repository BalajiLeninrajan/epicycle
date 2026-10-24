import { describe, expect, it } from 'vitest'
import { resample } from './resample'
import type { SinglePath } from './types'

function path(xy: number[], jumps?: number[]): SinglePath {
  const count = xy.length >> 1
  const jump = new Uint8Array(count)
  if (jumps) jump.set(jumps)
  return { points: new Float32Array(xy), jump }
}

function allFinite(a: Float64Array): boolean {
  for (const v of a) if (!Number.isFinite(v)) return false
  return true
}

describe('resample', () => {
  it('places samples evenly around a square', () => {
    // 10x10 square, perimeter 40; 8 samples land on corners and edge midpoints.
    const r = resample(path([0, 0, 10, 0, 10, 10, 0, 10]), 8)
    expect(r.centerX).toBeCloseTo(5)
    expect(r.centerY).toBeCloseTo(5)
    const px = Array.from(r.re, (v) => v * r.scale + r.centerX)
    const py = Array.from(r.im, (v) => v * r.scale + r.centerY)
    const want = [
      [0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5],
    ]
    for (let i = 0; i < 8; i++) {
      expect(px[i]).toBeCloseTo(want[i][0], 5)
      expect(py[i]).toBeCloseTo(want[i][1], 5)
    }
  })

  it('spaces consecutive samples equally by arc length', () => {
    const r = resample(path([0, 0, 30, 0, 30, 10, 0, 10]), 256)
    const step = 80 / 256
    for (let i = 0; i < 256; i++) {
      const j = (i + 1) % 256
      const dx = (r.re[j] - r.re[i]) * r.scale
      const dy = (r.im[j] - r.im[i]) * r.scale
      // Chords that cut a corner are shorter; straight ones equal the step.
      const d = Math.hypot(dx, dy)
      expect(d).toBeLessThanOrEqual(step + 1e-6)
      expect(d).toBeGreaterThan(step / Math.SQRT2 - 1e-6)
    }
  })

  it('centers on the mean and fits the unit disk', () => {
    const r = resample(path([3, 7, 50, 9, 20, 40]), 1024)
    let sx = 0
    let sy = 0
    let maxR = 0
    for (let i = 0; i < 1024; i++) {
      sx += r.re[i]
      sy += r.im[i]
      maxR = Math.max(maxR, Math.hypot(r.re[i], r.im[i]))
    }
    expect(Math.abs(sx / 1024)).toBeLessThan(1e-12)
    expect(Math.abs(sy / 1024)).toBeLessThan(1e-12)
    expect(maxR).toBeCloseTo(1, 12)
  })

  it('flags samples that fall on jump segments', () => {
    // Segments: 0->1 stroke (len 10), 1->2 jump (len 10), 2->3 stroke (len 10), closing 3->0 jump (len 10).
    const r = resample(path([0, 0, 10, 0, 10, 10, 0, 10], [0, 1, 0, 1]), 40)
    for (let i = 0; i < 40; i++) {
      const seg = Math.floor(i / 10)
      expect(r.jump[i]).toBe(seg === 1 || seg === 3 ? 1 : 0)
    }
  })

  it('skips zero-length segments and duplicate points', () => {
    const r = resample(path([0, 0, 0, 0, 10, 0, 10, 0, 10, 0, 10, 10, 0, 10, 0, 10], [1, 0, 1, 1, 0, 0, 1, 0]), 8)
    expect(allFinite(r.re)).toBe(true)
    expect(allFinite(r.im)).toBe(true)
    const px = Array.from(r.re, (v) => v * r.scale + r.centerX)
    expect(px[1]).toBeCloseTo(5, 5)
    // Sample 1 lies on 0,0 -> 10,0, which is segment 1 (not a jump); the zero-length jump at 0 is never hit.
    expect(r.jump[1]).toBe(0)
  })

  it('returns zeros without NaN for degenerate paths', () => {
    for (const p of [path([]), path([4, 4]), path([4, 4, 4, 4, 4, 4], [1, 1, 1])]) {
      const r = resample(p, 64)
      expect(r.re.length).toBe(64)
      expect(r.scale).toBe(1)
      expect(Array.from(r.re).every((v) => v === 0)).toBe(true)
      expect(Array.from(r.im).every((v) => v === 0)).toBe(true)
      expect(Number.isFinite(r.centerX) && Number.isFinite(r.centerY)).toBe(true)
    }
    expect(resample(path([4, 4]), 8).centerX).toBe(4)
  })

  it('handles a two point path as a back-and-forth line', () => {
    const r = resample(path([0, 0, 10, 0]), 4)
    const px = Array.from(r.re, (v) => v * r.scale + r.centerX)
    expect(px.map((v) => +v.toFixed(6))).toEqual([0, 5, 10, 5])
    expect(r.scale).toBeCloseTo(5)
  })

  it('handles n = 0', () => {
    const r = resample(path([0, 0, 1, 1]), 0)
    expect(r.re.length).toBe(0)
    expect(r.scale).toBe(1)
  })
})
