import { describe, expect, it } from 'vitest'
import { argmax, fitSize, invertUnitInPlace, resizePlane, rgbaToChw, sigmoidInPlace } from './tensor'

function rgba(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(px(x, y), 4 * (y * width + x))
  return { width, height, data }
}

describe('rgbaToChw', () => {
  it('writes planar RGB in [0, 1] at the same size', () => {
    const img = rgba(3, 2, (x, y) => [x * 100, y * 200, 50, 255])
    const t = rgbaToChw(img, 3, 2)
    expect(t.length).toBe(18)
    // R plane, G plane, B plane
    expect(Array.from(t.subarray(0, 6)).map((v) => Math.round(v * 255))).toEqual([0, 100, 200, 0, 100, 200])
    expect(Array.from(t.subarray(6, 12)).map((v) => Math.round(v * 255))).toEqual([0, 0, 0, 200, 200, 200])
    expect(Array.from(t.subarray(12, 18)).map((v) => Math.round(v * 255))).toEqual([50, 50, 50, 50, 50, 50])
  })

  it('applies mean and std per channel', () => {
    const img = rgba(1, 1, () => [255, 0, 51, 255])
    const t = rgbaToChw(img, 1, 1, [0.5, 0.5, 0.2], [0.5, 0.25, 0.1])
    expect(t[0]).toBeCloseTo(1)
    expect(t[1]).toBeCloseTo(-2)
    expect(t[2]).toBeCloseTo(0)
  })

  it('composites transparent pixels over white', () => {
    const img = rgba(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [0, 0, 0, 128]))
    const t = rgbaToChw(img, 2, 1)
    expect(t[0]).toBeCloseTo(1)
    expect(t[1]).toBeCloseTo(127 / 255, 2)
  })

  it('downsamples 2x by averaging pixel pairs', () => {
    const img = rgba(4, 2, (x) => (x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    const t = rgbaToChw(img, 2, 1)
    expect(t[0]).toBeCloseTo(0.5)
    expect(t[1]).toBeCloseTo(0.5)
  })

  it('upsamples a single pixel to a constant image', () => {
    const t = rgbaToChw(rgba(1, 1, () => [10, 20, 30, 255]), 4, 3)
    for (let i = 0; i < 12; i++) expect(t[i]).toBeCloseTo(10 / 255)
    for (let i = 24; i < 36; i++) expect(t[i]).toBeCloseTo(30 / 255)
  })

  it('handles empty input', () => {
    expect(rgbaToChw(rgba(0, 0, () => [0, 0, 0, 0]), 2, 2)).toEqual(new Float32Array(12))
    expect(rgbaToChw(rgba(2, 2, () => [0, 0, 0, 255]), 0, 0).length).toBe(0)
  })
})

describe('resizePlane', () => {
  it('is the identity at the same size', () => {
    const src = Float32Array.from([1, 2, 3, 4, 5, 6])
    expect(resizePlane(src, 3, 2, 3, 2)).toEqual(src)
  })

  it('interpolates linearly with clamped borders when upsampling', () => {
    const out = resizePlane(Float32Array.from([0, 1]), 2, 1, 4, 1)
    expect(Array.from(out)).toEqual([0, 0.25, 0.75, 1])
  })

  it('keeps a constant plane constant', () => {
    const out = resizePlane(new Float32Array(16).fill(0.3), 4, 4, 7, 5)
    for (const v of out) expect(v).toBeCloseTo(0.3)
  })

  it('crops to the top-left region before resizing', () => {
    // 4x4 source: left 2x2 block holds 1, padding holds 9.
    const src = new Float32Array(16).fill(9)
    src[0] = src[1] = src[4] = src[5] = 1
    const out = resizePlane(src, 4, 4, 6, 6, 2, 2)
    for (const v of out) expect(v).toBe(1)
  })

  it('maps a fractional crop', () => {
    // Ramp 0..7 along x. Crop of 4 source pixels resampled to 8 outputs stays inside [0, 3].
    const src = Float32Array.from({ length: 8 }, (_, i) => i)
    const out = resizePlane(src, 8, 1, 8, 1, 4, 1)
    expect(out[0]).toBe(0)
    expect(out[7]).toBeCloseTo(3)
    for (let i = 1; i < 8; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1])
  })

  it('handles empty planes', () => {
    expect(resizePlane(new Float32Array(0), 0, 0, 3, 3)).toEqual(new Float32Array(9))
    expect(resizePlane(new Float32Array(4), 2, 2, 0, 5).length).toBe(0)
  })
})

describe('sigmoidInPlace', () => {
  it('maps logits to probabilities without overflow', () => {
    const a = Float32Array.from([0, 2, -2, 1000, -1000])
    sigmoidInPlace(a)
    expect(a[0]).toBe(0.5)
    expect(a[1]).toBeCloseTo(0.8808, 4)
    expect(a[2]).toBeCloseTo(0.1192, 4)
    expect(a[3]).toBe(1)
    expect(a[4]).toBe(0)
    for (const v of a) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('invertUnitInPlace', () => {
  it('turns paper into 0 and ink into 1, clamping', () => {
    const a = Float32Array.from([1, 0, 0.25, 1.5, -0.5])
    expect(Array.from(invertUnitInPlace(a))).toEqual([0, 1, 0.75, 0, 1])
  })
})

describe('fitSize', () => {
  it('scales the long side and rounds to the multiple', () => {
    expect(fitSize(1024, 768, 512, 8)).toEqual({ width: 512, height: 384 })
    expect(fitSize(300, 1000, 512, 8)).toEqual({ width: 152, height: 512 })
  })

  it('upscales small images and never returns zero', () => {
    expect(fitSize(10, 10, 512, 8)).toEqual({ width: 512, height: 512 })
    expect(fitSize(2000, 1, 512, 8)).toEqual({ width: 512, height: 8 })
  })
})

describe('argmax', () => {
  it('finds the first maximum within a range', () => {
    expect(argmax([0.1, 0.9, 0.9, 0.2])).toBe(1)
    expect(argmax([5, 0.1, 0.3, 0.2], 1, 4)).toBe(1)
    expect(argmax([])).toBe(-1)
  })
})
