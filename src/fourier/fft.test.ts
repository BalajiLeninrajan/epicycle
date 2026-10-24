import { describe, expect, it } from 'vitest'
import { fft, ifft } from './fft'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

function random(n: number, seed: number): { re: Float64Array; im: Float64Array } {
  const r = rng(seed)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    re[i] = r()
    im[i] = r()
  }
  return { re, im }
}

function naiveDft(re: Float64Array, im: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = re.length
  const outRe = new Float64Array(n)
  const outIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let j = 0; j < n; j++) {
      const a = (-2 * Math.PI * ((j * k) % n)) / n
      const c = Math.cos(a)
      const s = Math.sin(a)
      sr += re[j] * c - im[j] * s
      si += re[j] * s + im[j] * c
    }
    outRe[k] = sr
    outIm[k] = si
  }
  return { re: outRe, im: outIm }
}

function maxDiff(a: Float64Array, b: Float64Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

describe('fft', () => {
  for (const n of [1, 2, 4, 8, 64, 512]) {
    it(`matches the naive DFT for n = ${n}`, () => {
      const x = random(n, n)
      const want = naiveDft(x.re, x.im)
      fft(x.re, x.im)
      expect(maxDiff(x.re, want.re)).toBeLessThan(1e-9)
      expect(maxDiff(x.im, want.im)).toBeLessThan(1e-9)
    })
  }

  it('maps an impulse to a flat spectrum', () => {
    const re = new Float64Array(16)
    const im = new Float64Array(16)
    re[0] = 1
    fft(re, im)
    for (let i = 0; i < 16; i++) {
      expect(re[i]).toBeCloseTo(1, 12)
      expect(im[i]).toBeCloseTo(0, 12)
    }
  })

  it('round trips through ifft', () => {
    for (const n of [2, 32, 4096]) {
      const x = random(n, 7 + n)
      const re = x.re.slice()
      const im = x.im.slice()
      fft(re, im)
      ifft(re, im)
      expect(maxDiff(re, x.re)).toBeLessThan(1e-12)
      expect(maxDiff(im, x.im)).toBeLessThan(1e-12)
    }
  })

  it('gives the same result when a cached plan is reused', () => {
    const a = random(128, 1)
    const b = { re: a.re.slice(), im: a.im.slice() }
    fft(a.re, a.im)
    fft(b.re, b.im)
    expect(maxDiff(a.re, b.re)).toBe(0)
    expect(maxDiff(a.im, b.im)).toBe(0)
  })

  it('throws on lengths that are not a power of 2', () => {
    for (const n of [0, 3, 6, 100]) {
      expect(() => fft(new Float64Array(n), new Float64Array(n))).toThrow()
      expect(() => ifft(new Float64Array(n), new Float64Array(n))).toThrow()
    }
  })

  it('throws on mismatched re/im lengths', () => {
    expect(() => fft(new Float64Array(8), new Float64Array(4))).toThrow()
  })
})
