import { describe, expect, it } from 'vitest'
import { createPipeline, largestComponentArea, type PipelineDeps } from './pipeline'
import { DEFAULT_SETTINGS, type GrayImage, type PipelineResult, type PipelineSettings, type SamPoint } from './types'

const W = 200
const H = 200
const CX = 100
const CY = 100

/** RGBA image, white where dark(x, y) is false and black where it is true. */
function makeImage(w: number, h: number, dark: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = dark(x, y) ? 0 : 255
      const i = 4 * (y * w + x)
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
  return { data, width: w, height: h, colorSpace: 'srgb' } as unknown as ImageData
}

/** Ring of radius 40 and a cross spanning nearly the whole canvas. */
const ringAndCross = () =>
  makeImage(W, H, (x, y) => {
    const r = Math.hypot(x - CX, y - CY)
    const ring = r >= 38 && r <= 42
    const cross = (Math.abs(y - CY) <= 1 && x >= 10 && x < 190) || (Math.abs(x - CX) <= 1 && y >= 10 && y < 190)
    return ring || cross
  })

function diskProb(w: number, h: number, cx: number, cy: number, r: number): GrayImage {
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.hypot(x - cx, y - cy) <= r ? 1 : 0
  return { width: w, height: h, data }
}

interface Fake extends PipelineDeps {
  calls: Record<'segment' | 'lineArt' | 'samSetImage' | 'samPredict', number>
  segReady: boolean
  lineReady: boolean
}

function fakeDeps(opts: { segmentProb?: GrayImage; lineProb?: (img: ImageData) => GrayImage; samProb?: GrayImage } = {}): Fake {
  const f: Fake = {
    calls: { segment: 0, lineArt: 0, samSetImage: 0, samPredict: 0 },
    segReady: opts.segmentProb !== undefined,
    lineReady: opts.lineProb !== undefined,
    segmenterReady: () => f.segReady,
    lineArtReady: () => f.lineReady,
    async segment() {
      f.calls.segment++
      if (!opts.segmentProb) throw new Error('segment called while not ready')
      return opts.segmentProb
    },
    async lineArt(img) {
      f.calls.lineArt++
      if (!opts.lineProb) throw new Error('lineArt called while not ready')
      return opts.lineProb(img)
    },
    async samSetImage() {
      f.calls.samSetImage++
    },
    async samPredict(_points: SamPoint[]) {
      f.calls.samPredict++
      if (!opts.samProb) throw new Error('no sam prob')
      return opts.samProb
    },
  }
  return f
}

const settings = (s: Partial<PipelineSettings> = {}): PipelineSettings => ({
  ...DEFAULT_SETTINGS,
  lineStyle: 'canny',
  keepBackground: true,
  sampleCount: 2048,
  ...s,
})

function strokePoints(r: PipelineResult): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const s of r.strokes) for (let i = 0; i < s.length; i += 2) out.push([s[i], s[i + 1]])
  return out
}

const allFinite = (a: ArrayLike<number>) => Array.prototype.every.call(a, Number.isFinite)

function expectFinite(r: PipelineResult) {
  for (const a of [r.sampled.re, r.sampled.im, r.coeffs.re, r.coeffs.im, r.coeffs.amp, r.path.points])
    expect(allFinite(a)).toBe(true)
  expect(Number.isFinite(r.sampled.scale)).toBe(true)
  expect(Number.isFinite(r.sampled.centerX)).toBe(true)
  expect(Number.isFinite(r.sampled.centerY)).toBe(true)
}

function expectEmpty(r: PipelineResult, n: number) {
  expect(r.strokes.length).toBe(0)
  expect(r.path.points.length).toBe(0)
  expect(r.path.jump.length).toBe(0)
  expect(r.sampled.re.length).toBe(n)
  expect(r.coeffs.n).toBe(n)
  expect(r.coeffs.freq.length).toBe(n)
  expect(r.coeffs.amp.every((v) => v === 0)).toBe(true)
  expectFinite(r)
}

describe('createPipeline', () => {
  it('draws a ring and cross with canny and no mask', async () => {
    const deps = fakeDeps()
    const p = createPipeline(deps)
    expect(p.setImage(ringAndCross())).toEqual({ width: W, height: H })
    const r = await p.run(settings())
    expect(r.usedLineStyle).toBe('canny')
    expect(r.masked).toBe(false)
    expect(r.width).toBe(W)
    expect(r.strokes.length).toBeGreaterThan(0)
    expect(r.path.points.length).toBeGreaterThan(4)
    expect(r.path.jump.length).toBe(r.path.points.length / 2)
    expect(r.sampled.re.length).toBe(2048)
    expect(r.coeffs.n).toBe(2048)
    expect(r.coeffs.amp[0]).toBeGreaterThan(0)
    expectFinite(r)
    let maxR = 0
    for (let i = 0; i < 2048; i++) maxR = Math.max(maxR, Math.hypot(r.sampled.re[i], r.sampled.im[i]))
    expect(maxR).toBeLessThanOrEqual(1 + 1e-9)
    // The cross reaches x = 10..190, so strokes must too.
    const xs = strokePoints(r).map(([x]) => x)
    expect(Math.min(...xs)).toBeLessThan(20)
    expect(Math.max(...xs)).toBeGreaterThan(180)
    expect(r.timings.total).toBeGreaterThanOrEqual(0)
    expect(deps.calls.segment + deps.calls.lineArt).toBe(0)
  })

  it('falls back to canny when the line model is not ready', async () => {
    const deps = fakeDeps()
    const p = createPipeline(deps)
    p.setImage(ringAndCross())
    const r = await p.run(settings({ lineStyle: 'ai' }))
    expect(r.usedLineStyle).toBe('canny')
    expect(deps.calls.lineArt).toBe(0)
  })

  it('reruns only the stages after the changed setting', async () => {
    const deps = fakeDeps({ segmentProb: diskProb(W, H, CX, CY, 60) })
    const p = createPipeline(deps)
    p.setImage(ringAndCross())
    const a = await p.run(settings({ keepBackground: false }))
    for (const stage of ['gray', 'segment', 'mask', 'canny', 'thin', 'trace', 'clean', 'order', 'resample', 'coeffs'])
      expect(a.timings, stage).toHaveProperty(stage)

    const b = await p.run(settings({ keepBackground: false, sampleCount: 4096 }))
    expect(b.strokes).toBe(a.strokes)
    expect(b.path).toBe(a.path)
    expect(b.sampled.re.length).toBe(4096)
    expect(Object.keys(b.timings).sort()).toEqual(['coeffs', 'resample', 'total'])

    const c = await p.run(settings({ keepBackground: false, sampleCount: 4096, simplifyEpsilon: 3 }))
    expect(c.timings).toHaveProperty('clean')
    expect(c.timings).not.toHaveProperty('thin')
    expect(c.timings).not.toHaveProperty('canny')

    const d = await p.run(settings({ keepBackground: false, detail: 0.9 }))
    expect(d.timings).toHaveProperty('canny')
    expect(d.timings).not.toHaveProperty('mask')
    expect(deps.calls.segment).toBe(1)

    // Back to the first settings: everything after mask is recomputed, but the image stages are not.
    const e = await p.run(settings({ keepBackground: false }))
    expect(e.timings).not.toHaveProperty('gray')
    expect(deps.calls.segment).toBe(1)
  })

  it('clears caches on setImage', async () => {
    const deps = fakeDeps({ segmentProb: diskProb(W, H, CX, CY, 60) })
    const p = createPipeline(deps)
    p.setImage(ringAndCross())
    await p.run(settings({ keepBackground: false }))
    p.setImage(ringAndCross())
    const r = await p.run(settings({ keepBackground: false }))
    expect(deps.calls.segment).toBe(2)
    expect(r.timings).toHaveProperty('gray')
  })

  it('drops strokes outside the segmenter mask', async () => {
    const R = 50
    const deps = fakeDeps({ segmentProb: diskProb(W, H, CX, CY, R) })
    const p = createPipeline(deps)
    p.setImage(ringAndCross())

    const free = await p.run(settings({ keepBackground: true }))
    expect(free.masked).toBe(false)
    const dist = (r: PipelineResult) => strokePoints(r).map(([x, y]) => Math.hypot(x - CX, y - CY))
    expect(Math.max(...dist(free))).toBeGreaterThan(80)

    const masked = await p.run(settings({ keepBackground: false }))
    expect(masked.masked).toBe(true)
    expect(masked.strokes.length).toBeGreaterThan(0)
    // Mask radius + line dilation (2px) + a pixel of contour slack.
    expect(Math.max(...dist(masked))).toBeLessThan(R + 4)
    const pts = masked.path.points
    let maxD = 0
    for (let i = 0; i < pts.length; i += 2) maxD = Math.max(maxD, Math.hypot(pts[i] - CX, pts[i + 1] - CY))
    expect(maxD).toBeLessThan(R + 4)
    expectFinite(masked)

    // The silhouette adds the mask boundary as one extra stroke.
    const noSil = await p.run(settings({ keepBackground: false, includeSilhouette: false }))
    expect(masked.strokes.length).toBe(noSil.strokes.length + 1)
    expect(noSil.timings).not.toHaveProperty('thin')

    const outline = await p.getMaskOutline()
    expect(outline.length).toBe(1)
    const o = outline[0]
    let maxErr = 0
    for (let i = 0; i < o.length; i += 2) maxErr = Math.max(maxErr, Math.abs(Math.hypot(o[i] - CX, o[i + 1] - CY) - R))
    expect(maxErr).toBeLessThan(2)
  })

  it('ignores a segmenter that is not ready', async () => {
    const deps = fakeDeps({ segmentProb: diskProb(W, H, CX, CY, 50) })
    deps.segReady = false
    const p = createPipeline(deps)
    p.setImage(ringAndCross())
    const r = await p.run(settings({ keepBackground: false }))
    expect(r.masked).toBe(false)
    expect(deps.calls.segment).toBe(0)
    expect(await p.getMaskOutline()).toEqual([])
  })

  it('treats an empty segmenter mask as no mask', async () => {
    const deps = fakeDeps({ segmentProb: diskProb(W, H, CX, CY, -1) })
    const p = createPipeline(deps)
    p.setImage(ringAndCross())
    const r = await p.run(settings({ keepBackground: false }))
    expect(r.masked).toBe(false)
    expect(r.strokes.length).toBeGreaterThan(0)
  })

  it('uses the AI line model when ready and caches its output', async () => {
    const ink = (img: ImageData): GrayImage => {
      const n = img.width * img.height
      const data = new Float32Array(n)
      for (let i = 0; i < n; i++) data[i] = 1 - img.data[4 * i] / 255
      return { width: img.width, height: img.height, data }
    }
    const deps = fakeDeps({ lineProb: ink })
    const p = createPipeline(deps)
    p.setImage(ringAndCross())
    const a = await p.run(settings({ lineStyle: 'ai' }))
    expect(a.usedLineStyle).toBe('ai')
    expect(a.strokes.length).toBeGreaterThan(0)
    expectFinite(a)
    const b = await p.run(settings({ lineStyle: 'ai', detail: 0.1 }))
    expect(b.timings).toHaveProperty('lineThreshold')
    expect(deps.calls.lineArt).toBe(1)
  })

  it('applies SAM clicks and returns to the auto mask on an empty list', async () => {
    const deps = fakeDeps({ samProb: diskProb(W, H, CX, CY, 45) })
    const p = createPipeline(deps)
    p.setImage(ringAndCross())
    const pts = [{ x: 0.5, y: 0.5, positive: true }]
    const o1 = await p.setSamPoints(pts)
    expect(o1.length).toBe(1)
    const o2 = await p.setSamPoints([...pts, { x: 0.9, y: 0.9, positive: false }])
    expect(o2.length).toBe(1)
    expect(deps.calls.samSetImage).toBe(1)
    expect(deps.calls.samPredict).toBe(2)

    const r = await p.run(settings({ keepBackground: false }))
    expect(r.masked).toBe(true)
    expect(Math.max(...strokePoints(r).map(([x, y]) => Math.hypot(x - CX, y - CY)))).toBeLessThan(45 + 4)

    // No segmenter, so clearing the clicks leaves no mask.
    expect(await p.setSamPoints([])).toEqual([])
    expect((await p.run(settings({ keepBackground: false }))).masked).toBe(false)

    // A new image needs new embeddings.
    p.setImage(ringAndCross())
    await p.setSamPoints(pts)
    expect(deps.calls.samSetImage).toBe(2)
  })

  it('keeps only the latest of overlapping SAM requests', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const small = diskProb(W, H, CX, CY, 20)
    const big = diskProb(W, H, CX, CY, 60)
    let call = 0
    const deps = fakeDeps()
    deps.samPredict = async () => {
      call++
      if (call === 1) {
        await gate
        return small
      }
      return big
    }
    const p = createPipeline(deps)
    p.setImage(ringAndCross())
    const first = p.setSamPoints([{ x: 0.5, y: 0.5, positive: true }])
    const second = await p.setSamPoints([{ x: 0.5, y: 0.5, positive: true }])
    release()
    await first
    const outline = await p.getMaskOutline()
    expect(outline).toEqual(second)
    expect(Math.hypot(outline[0][0] - CX, outline[0][1] - CY)).toBeGreaterThan(55)
  })

  it('returns a valid empty result for a blank image', async () => {
    const p = createPipeline(fakeDeps())
    p.setImage(makeImage(64, 48, () => false))
    const r = await p.run(settings())
    expectEmpty(r, 2048)
    expect(r.width).toBe(64)
    expect(r.sampled.centerX).toBe(32)
  })

  it('handles a single pixel image and dots on the border', async () => {
    const p = createPipeline(fakeDeps())
    p.setImage(makeImage(1, 1, () => true))
    expectFinite(await p.run(settings()))
    p.setImage(makeImage(32, 32, (x, y) => x === 0 || y === 31))
    expectFinite(await p.run(settings({ detail: 1 })))
  })

  it('returns an empty result before any image is set', async () => {
    const p = createPipeline(fakeDeps())
    const r = await p.run(settings({ sampleCount: 4096 }))
    expectEmpty(r, 4096)
    expect(await p.getMaskOutline()).toEqual([])
    expect(await p.setSamPoints([{ x: 0.5, y: 0.5, positive: true }])).toEqual([])
  })

  it('stipples into a single tour', async () => {
    const p = createPipeline(fakeDeps({ segmentProb: diskProb(W, H, CX, CY, 60) }))
    p.setImage(
      makeImage(W, H, (x, y) => Math.hypot(x - CX, y - CY) < 50 && (x + y) % 3 === 0),
    )
    const r = await p.run(settings({ lineStyle: 'stipple', stippleCount: 150, keepBackground: false }))
    expect(r.usedLineStyle).toBe('stipple')
    expect(r.masked).toBe(true)
    expect(r.strokes).toEqual([])
    expect(r.path.points.length).toBeGreaterThan(100)
    expect(r.path.jump.every((v) => v === 0)).toBe(true)
    expectFinite(r)

    const none = await p.run(settings({ lineStyle: 'stipple', stippleCount: 0 }))
    expectEmpty(none, 2048)
    expect(none.usedLineStyle).toBe('stipple')
  })

  describe('runStrokes', () => {
    const square = Float32Array.from([10, 10, 50, 10, 50, 50, 10, 50, 10, 10])
    const line = Float32Array.from([70, 70, 90, 95])

    it('orders given strokes and transforms them', () => {
      const p = createPipeline(fakeDeps())
      const r = p.runStrokes([square, line], 100, 100, 2048)
      expect(r.strokes.length).toBe(2)
      expect(r.path.points.length).toBeGreaterThan(0)
      expect(r.path.jump.some((v) => v === 1)).toBe(true)
      expect(r.coeffs.n).toBe(2048)
      expect(r.masked).toBe(false)
      expectFinite(r)
    })

    it('drops degenerate strokes and rounds the sample count to a power of two', () => {
      const p = createPipeline(fakeDeps())
      const bad = Float32Array.from([1, Number.NaN, 3, 4])
      const r = p.runStrokes([square, bad, Float32Array.from([5, 5])], 100, 100, 3000)
      expect(r.strokes).toEqual([square])
      expect(r.coeffs.n).toBe(4096)
      expectFinite(r)
    })

    it('returns an empty result for no strokes or a zero-length stroke', () => {
      const p = createPipeline(fakeDeps())
      expectEmpty(p.runStrokes([], 100, 100, 2048), 2048)
      const dot = p.runStrokes([Float32Array.from([5, 5, 5, 5])], 100, 100, 2048)
      expect(dot.path.points.length).toBe(0)
      expectFinite(dot)
    })
  })
})

describe('largestComponentArea', () => {
  it('measures 8-connected blobs, including on the border', () => {
    const w = 6
    const h = 4
    // Diagonal chain of 3 at the top-left corner, a 2x2 block at the bottom-right corner.
    const data = new Uint8Array(w * h)
    data[0] = data[w + 1] = data[2 * w + 2] = 1
    data[2 * w + 4] = data[2 * w + 5] = data[3 * w + 4] = data[3 * w + 5] = 1
    data[3 * w + 5] = 1
    expect(largestComponentArea({ width: w, height: h, data })).toBe(4)
    expect(largestComponentArea({ width: 0, height: 0, data: new Uint8Array(0) })).toBe(0)
  })
})
