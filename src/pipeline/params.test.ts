import { describe, expect, it } from 'vitest'
import { deriveParams } from './params'
import { DEFAULT_SETTINGS, type PipelineSettings } from './types'

const at = (detail: number, extra: Partial<PipelineSettings> = {}, w = 800, h = 600) =>
  deriveParams({ ...DEFAULT_SETTINGS, ...extra, detail }, w, h)

describe('deriveParams', () => {
  it('is monotonic in detail', () => {
    let prev = at(0)
    for (let i = 1; i <= 20; i++) {
      const cur = at(i / 20)
      expect(cur.lineThreshold).toBeLessThan(prev.lineThreshold)
      expect(cur.minStrokeLength).toBeLessThan(prev.minStrokeLength)
      expect(cur.simplifyEpsilon).toBeLessThan(prev.simplifyEpsilon)
      expect(cur.cannySigma).toBeLessThan(prev.cannySigma)
      expect(cur.cannyHigh).toBeLessThan(prev.cannyHigh)
      expect(cur.cannyLow).toBeLessThan(prev.cannyLow)
      prev = cur
    }
  })

  it('hits the documented endpoints', () => {
    const lo = at(0)
    const hi = at(1)
    expect(lo.lineThreshold).toBeCloseTo(0.6)
    expect(hi.lineThreshold).toBeCloseTo(0.3)
    expect(lo.simplifyEpsilon).toBeCloseTo(2)
    expect(hi.simplifyEpsilon).toBeCloseTo(0.5)
    expect(lo.minStrokeLength).toBeCloseTo(1000 * 0.03)
    for (const p of [lo, hi]) {
      expect(p.cannyLow).toBeLessThan(p.cannyHigh)
      expect(p.cannyHigh).toBeLessThanOrEqual(1)
      expect(p.cannyLow).toBeGreaterThan(0)
    }
  })

  it('clamps detail outside 0..1 and survives NaN', () => {
    expect(at(-3)).toEqual(at(0))
    expect(at(7)).toEqual(at(1))
    expect(at(Number.NaN)).toEqual(at(0.5))
  })

  it('scales minStrokeLength with the image diagonal', () => {
    const small = at(0.5, {}, 400, 300)
    const big = at(0.5, {}, 800, 600)
    expect(big.minStrokeLength).toBeCloseTo(2 * small.minStrokeLength)
    expect(big.simplifyEpsilon).toBe(small.simplifyEpsilon)
  })

  it('keeps minStrokeLength at least 2px on tiny or empty images', () => {
    expect(at(1, {}, 10, 10).minStrokeLength).toBe(2)
    expect(at(0, {}, 0, 0).minStrokeLength).toBe(2)
  })

  it('lets overrides win', () => {
    const p = at(0.2, { lineThreshold: 0.9, minStrokeLength: 0, simplifyEpsilon: 5 })
    expect(p.lineThreshold).toBe(0.9)
    expect(p.minStrokeLength).toBe(0)
    expect(p.simplifyEpsilon).toBe(5)
    expect(p.cannySigma).toBe(at(0.2).cannySigma)
  })
})
