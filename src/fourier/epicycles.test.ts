import { describe, expect, it } from 'vitest'
import type { SampledPath } from '../pipeline/types'
import { computeCoeffs, evalChain, reconstruct } from './epicycles'

function path(n: number, fn: (t: number) => [number, number]): SampledPath {
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    const [x, y] = fn(j / n)
    re[j] = x
    im[j] = y
  }
  return { re, im, jump: new Uint8Array(n), scale: 1, centerX: 0, centerY: 0 }
}

/** A closed square traced by arc length, as a non-trivial test shape. */
function square(t: number): [number, number] {
  const s = (t * 4) % 4
  const side = Math.floor(s)
  const u = s - side
  switch (side) {
    case 0:
      return [-0.5 + u, -0.5]
    case 1:
      return [0.5, -0.5 + u]
    case 2:
      return [0.5 - u, 0.5]
    default:
      return [-0.5, 0.5 - u]
  }
}

describe('computeCoeffs', () => {
  it('finds a single coefficient for a pure circle', () => {
    const r = 0.7
    const c = computeCoeffs(path(64, (t) => [r * Math.cos(2 * Math.PI * 3 * t), r * Math.sin(2 * Math.PI * 3 * t)]))
    expect(c.n).toBe(64)
    expect(c.freq.length).toBe(64)
    expect(c.freq[0]).toBe(3)
    expect(c.amp[0]).toBeCloseTo(r, 12)
    expect(c.re[0]).toBeCloseTo(r, 12)
    expect(c.im[0]).toBeCloseTo(0, 12)
    for (let i = 1; i < 64; i++) expect(c.amp[i]).toBeLessThan(1e-12)
  })

  it('handles negative frequencies and phase', () => {
    // 0.4 e^{i pi/4} e^{-2 pi i 5 t} + 0.1
    const c = computeCoeffs(
      path(32, (t) => {
        const a = Math.PI / 4 - 2 * Math.PI * 5 * t
        return [0.4 * Math.cos(a) + 0.1, 0.4 * Math.sin(a)]
      }),
    )
    expect(c.freq[0]).toBe(-5)
    expect(c.re[0]).toBeCloseTo(0.4 * Math.SQRT1_2, 12)
    expect(c.im[0]).toBeCloseTo(0.4 * Math.SQRT1_2, 12)
    expect(c.freq[1]).toBe(0)
    expect(c.re[1]).toBeCloseTo(0.1, 12)
  })

  it('sorts by amplitude descending and covers every frequency once', () => {
    const n = 256
    const c = computeCoeffs(path(n, square))
    for (let i = 1; i < n; i++) expect(c.amp[i]).toBeLessThanOrEqual(c.amp[i - 1])
    const seen = new Set<number>()
    for (let i = 0; i < n; i++) {
      expect(c.freq[i]).toBeGreaterThanOrEqual(-n / 2)
      expect(c.freq[i]).toBeLessThan(n / 2)
      expect(c.amp[i]).toBeCloseTo(Math.hypot(c.re[i], c.im[i]), 14)
      seen.add(c.freq[i])
    }
    expect(seen.size).toBe(n)
  })

  it('breaks amplitude ties by smaller |n| first', () => {
    // All zeros: every amplitude ties.
    const c = computeCoeffs(path(8, () => [0, 0]))
    expect(Array.from(c.freq)).toEqual([0, 1, -1, 2, -2, 3, -3, -4])
  })

  it('handles a single sample', () => {
    const c = computeCoeffs(path(1, () => [0.3, -0.2]))
    expect(c.n).toBe(1)
    expect(c.freq[0]).toBe(0)
    expect(c.re[0]).toBeCloseTo(0.3, 15)
    expect(c.im[0]).toBeCloseTo(-0.2, 15)
  })

  it('does not modify the input path', () => {
    const p = path(16, square)
    const before = p.re.slice()
    computeCoeffs(p)
    expect(p.re).toEqual(before)
  })

  it('throws on a non power of 2 sample count', () => {
    expect(() => computeCoeffs(path(12, square))).toThrow()
  })
})

describe('reconstruct', () => {
  it('reproduces the samples with k = N', () => {
    const n = 512
    const p = path(n, square)
    const c = computeCoeffs(p)
    const out = reconstruct(c, n, n)
    for (let j = 0; j < n; j++) {
      expect(out.re[j]).toBeCloseTo(p.re[j], 10)
      expect(out.im[j]).toBeCloseTo(p.im[j], 10)
    }
  })

  it('evaluates at a finer resolution than the input', () => {
    const r = 0.5
    const c = computeCoeffs(path(16, (t) => [r * Math.cos(2 * Math.PI * -2 * t), r * Math.sin(2 * Math.PI * -2 * t)]))
    const out = reconstruct(c, 16, 64)
    for (let j = 0; j < 64; j++) {
      const a = 2 * Math.PI * -2 * (j / 64)
      expect(out.re[j]).toBeCloseTo(r * Math.cos(a), 12)
      expect(out.im[j]).toBeCloseTo(r * Math.sin(a), 12)
    }
  })

  it('skips terms that would alias at a coarser resolution', () => {
    // Circle at freq 6 plus offset; at n = 8 freq 6 is outside [-4, 4) and dropped.
    const c = computeCoeffs(
      path(32, (t) => [0.3 * Math.cos(2 * Math.PI * 6 * t) + 0.2, 0.3 * Math.sin(2 * Math.PI * 6 * t)]),
    )
    const out = reconstruct(c, 32, 8)
    for (let j = 0; j < 8; j++) {
      expect(out.re[j]).toBeCloseTo(0.2, 12)
      expect(out.im[j]).toBeCloseTo(0, 12)
    }
  })

  it('returns all zeros for k = 0 and clamps k above the term count', () => {
    const c = computeCoeffs(path(16, square))
    const zero = reconstruct(c, 0, 16)
    expect(zero.re.every((v) => v === 0)).toBe(true)
    expect(zero.im.every((v) => v === 0)).toBe(true)
    const all = reconstruct(c, 16, 16)
    const over = reconstruct(c, 1000, 16)
    expect(over.re).toEqual(all.re)
  })

  it('throws on a bad n', () => {
    const c = computeCoeffs(path(8, square))
    expect(() => reconstruct(c, 8, 1)).toThrow()
    expect(() => reconstruct(c, 8, 12)).toThrow()
  })
})

describe('evalChain', () => {
  it('starts at the origin and ends on the reconstructed curve', () => {
    const n = 256
    const c = computeCoeffs(path(n, square))
    for (const k of [1, 10, 50, n]) {
      const curve = reconstruct(c, k, n)
      const out = new Float64Array(2 * (k + 1))
      for (const j of [0, 1, 37, 128, 255]) {
        evalChain(c, k, j / n, out)
        expect(out[0]).toBe(0)
        expect(out[1]).toBe(0)
        expect(out[2 * k]).toBeCloseTo(curve.re[j], 10)
        expect(out[2 * k + 1]).toBeCloseTo(curve.im[j], 10)
      }
    }
  })

  it('links consecutive joints by each term in sorted order', () => {
    const c = computeCoeffs(path(64, square))
    const k = 5
    const t = 0.123
    const out = new Float64Array(2 * (k + 1))
    evalChain(c, k, t, out)
    for (let i = 0; i < k; i++) {
      const dx = out[2 * i + 2] - out[2 * i]
      const dy = out[2 * i + 3] - out[2 * i + 1]
      expect(Math.hypot(dx, dy)).toBeCloseTo(c.amp[i], 12)
      const a = 2 * Math.PI * c.freq[i] * t
      expect(dx).toBeCloseTo(c.re[i] * Math.cos(a) - c.im[i] * Math.sin(a), 12)
      expect(dy).toBeCloseTo(c.re[i] * Math.sin(a) + c.im[i] * Math.cos(a), 12)
    }
  })

  it('writes only the origin for k = 0', () => {
    const c = computeCoeffs(path(8, square))
    const out = new Float64Array(4).fill(9)
    evalChain(c, 0, 0.5, out)
    expect(Array.from(out)).toEqual([0, 0, 9, 9])
  })

  it('parks extra joints on the tip when k exceeds the term count', () => {
    const c = computeCoeffs(path(8, square))
    const out = new Float64Array(2 * 13)
    evalChain(c, 12, 0.25, out)
    for (let i = 9; i <= 12; i++) {
      expect(out[2 * i]).toBe(out[16])
      expect(out[2 * i + 1]).toBe(out[17])
    }
  })
})
