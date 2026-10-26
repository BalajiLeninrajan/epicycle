import { describe, expect, it } from 'vitest'
import {
  decodeDrawing,
  encodeDrawing,
  fromBase64Url,
  packDrawing,
  shareId,
  toBase64Url,
  unpackDrawing,
  type SharedDrawing,
} from './codec'

function drawing(points: number[], jump: number[], over: Partial<SharedDrawing> = {}): SharedDrawing {
  return {
    width: 687,
    height: 1024,
    path: { points: Float32Array.from(points), jump: Uint8Array.from(jump) },
    sampleCount: 8192,
    circles: 1000,
    durationSec: 20,
    trailMode: 'fade',
    showCircles: true,
    showArrows: false,
    showFormula: true,
    followTip: false,
    followZoom: 6,
    lineWidth: 2,
    fadeFraction: 0.35,
    ...over,
  }
}

/** A wiggly path of n points with a jump every 40 segments. */
function wiggle(n: number): SharedDrawing {
  const pts: number[] = []
  const jump: number[] = []
  for (let i = 0; i < n; i++) {
    pts.push(300 + 250 * Math.cos(i / 37) + 3 * Math.sin(i), 500 + 400 * Math.sin(i / 53))
    jump.push(i % 40 === 39 ? 1 : 0)
  }
  return drawing(pts, jump)
}

describe('share codec', () => {
  it('round trips settings exactly and points to within half a grid step', async () => {
    const d = wiggle(2000)
    const back = await decodeDrawing(await encodeDrawing(d))
    const { path, ...settings } = back
    const { path: _, ...expected } = d
    expect(settings).toEqual(expected)
    expect(Array.from(path.jump)).toEqual(Array.from(d.path.jump))
    const step = 1024 / 4095
    for (let i = 0; i < d.path.points.length; i++) {
      expect(Math.abs(path.points[i] - d.path.points[i])).toBeLessThanOrEqual(step / 2 + 1e-3)
    }
  })

  it('keeps every flag combination', () => {
    const base = wiggle(10)
    for (let f = 0; f < 32; f++) {
      const d = {
        ...base,
        trailMode: f & 1 ? 'full' : 'fade',
        showCircles: !!(f & 2),
        showArrows: !!(f & 4),
        showFormula: !!(f & 8),
        followTip: !!(f & 16),
      } as SharedDrawing
      const back = unpackDrawing(packDrawing(d))
      expect([back.trailMode, back.showCircles, back.showArrows, back.showFormula, back.followTip]).toEqual([
        d.trailMode,
        d.showCircles,
        d.showArrows,
        d.showFormula,
        d.followTip,
      ])
    }
  })

  it('fits a typical portrait in a few kilobytes', async () => {
    const bytes = await encodeDrawing(wiggle(2000))
    expect(toBase64Url(bytes).length).toBeLessThan(6000)
  })

  it('base64url round trips any bytes', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 255)
    const text = toBase64Url(bytes)
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes))
  })

  it('rejects damaged or foreign input with a readable message', async () => {
    const good = await encodeDrawing(wiggle(100))
    await expect(decodeDrawing(new Uint8Array(0))).rejects.toThrow(/empty or too large/)
    await expect(decodeDrawing(good.slice(0, good.length >> 1))).rejects.toThrow(/damaged|cut short/)
    expect(() => unpackDrawing(Uint8Array.from([1, 2, 3]))).toThrow(/not an epicycle drawing/)
    const packed = packDrawing(wiggle(100))
    packed[1] = 9
    expect(() => unpackDrawing(packed)).toThrow(/newer version/)
    expect(() => fromBase64Url('abc$')).toThrow(/damaged/)
  })

  it('rejects trailing data and out-of-range jumps', () => {
    const packed = packDrawing(wiggle(50))
    expect(() => unpackDrawing(Uint8Array.from([...packed, 0]))).toThrow(/trailing/)
    const d = wiggle(5)
    const bad = packDrawing({ ...d, path: { points: d.path.points, jump: Uint8Array.from([0, 0, 0, 0, 1]) } })
    // Point the only jump past the end: the last byte is its gap (4); make it 9.
    bad[bad.length - 1] = 9
    expect(() => unpackDrawing(bad)).toThrow(/jump out of range/)
  })

  it('stops a decompression bomb before inflating it all', async () => {
    const zeros = new Uint8Array(8 * 1024 * 1024)
    const bomb = new Uint8Array(await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
    await expect(decodeDrawing(bomb)).rejects.toThrow(/too large/)
  })

  it('gives the same short id for the same drawing', async () => {
    const a = await encodeDrawing(wiggle(300))
    const b = await encodeDrawing(wiggle(300))
    expect(await shareId(a)).toBe(await shareId(b))
    expect(await shareId(a)).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })
})
