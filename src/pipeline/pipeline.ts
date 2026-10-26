// Pipeline orchestration with per-stage caching. Pure: models are injected, so it runs in node tests.
import { computeCoeffs } from '../fourier/epicycles'
import { canny } from './canny'
import { outerContours, trimImageBorder } from './contour'
import { toGray } from './image'
import { and, close, dilate, erode, fillHoles, removeSmallComponents, threshold } from './morph'
import { orderStrokes } from './order'
import { deriveParams } from './params'
import { resample } from './resample'
import { stipple, tourPoints } from './stipple'
import { zhangSuen } from './thin'
import { cleanStrokes, traceSkeleton } from './trace'
import type {
  BinaryImage,
  Coeffs,
  GrayImage,
  LineStyle,
  PipelineResult,
  PipelineSettings,
  Polyline,
  SampledPath,
  SamPoint,
  SinglePath,
} from './types'

export interface PipelineDeps {
  /** Foreground probability, same size as the image. Called only when segmenterReady() is true. */
  segment(image: ImageData): Promise<GrayImage>
  /** Ink probability, same size as the image. Called only when lineArtReady() is true. */
  lineArt(image: ImageData): Promise<GrayImage>
  /** SAM must be loaded before setSamPoints is called with clicks. */
  samSetImage(image: ImageData): Promise<void>
  samPredict(points: SamPoint[]): Promise<GrayImage>
  segmenterReady(): boolean
  lineArtReady(): boolean
  /** Load SAM before the first click is predicted. Defaults to a no-op. */
  loadSam?(): Promise<void>
  /**
   * A ready model failed at inference. The run carries on without it (no mask, or Canny
   * lines), so the owner should mark the model unusable so the next run doesn't retry it.
   */
  onInferenceError?(model: 'segment' | 'lineart', err: unknown): void
  /** Clock for timings. Defaults to performance.now. */
  now?(): number
}

export interface Pipeline {
  /**
   * Replace the source image and drop every cache, including SAM clicks. cutout is the
   * alpha of a transparent image (see flattenCutout); it stands in for the auto mask.
   */
  setImage(image: ImageData, cutout?: GrayImage | null): { width: number; height: number }
  /** Replace the SAM clicks (empty = back to the auto mask). Resolves with the mask outline. */
  setSamPoints(points: SamPoint[]): Promise<Polyline[]>
  /** Outer contours of the SAM mask if there are clicks, else of the auto mask. Empty when there is no mask. */
  getMaskOutline(): Promise<Polyline[]>
  run(settings: PipelineSettings): Promise<PipelineResult>
  /** SVG mode: order, resample and transform given strokes. */
  runStrokes(strokes: Polyline[], width: number, height: number, sampleCount: number): PipelineResult
  /** Shared drawings: the path is already ordered, so only resample and transform it. */
  runPath(path: SinglePath, width: number, height: number, sampleCount: number): PipelineResult
}

/** Binarization cutoff for mask probabilities. */
const MASK_THRESHOLD = 0.5
/** Close radius as a fraction of the image diagonal. */
const MASK_CLOSE_FRAC = 0.01
/** Mask blobs smaller than this fraction of the largest blob are dropped. */
const MASK_MIN_BLOB_FRAC = 0.01
/**
 * Band around the mask edge (fraction of diagonal, min 2px). Without the silhouette, line
 * pixels may sit this far outside the mask so edges on the outline survive. With it, line
 * pixels this close to the edge are dropped instead: the silhouette already draws that
 * boundary, and keeping both gives a doubled outline.
 */
const LINE_MASK_BAND_FRAC = 0.005
const STIPPLE_ITERATIONS = 20

interface Cached {
  key: string
  value: unknown
}

interface ImageState {
  image: ImageData
  cutout: GrayImage | null
  width: number
  height: number
  diag: number
  cache: Map<string, Cached>
  autoProb: Promise<GrayImage> | null
  autoProbValue: GrayImage | null
  lineProb: Promise<GrayImage> | null
  samPoints: SamPoint[]
  samProb: GrayImage | null
  samVersion: number
  samSeq: number
  samEmbed: Promise<void> | null
}

interface MaskInfo {
  mask: BinaryImage | null
  key: string
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const now = deps.now ?? (() => performance.now())
  let st: ImageState | null = null

  function memo<T>(s: { cache: Map<string, Cached> }, stage: string, key: string, timings: Record<string, number>, fn: () => T): T {
    const c = s.cache.get(stage)
    if (c && c.key === key) return c.value as T
    const t0 = now()
    const value = fn()
    timings[stage] = now() - t0
    s.cache.set(stage, { key, value })
    return value
  }

  function ensureAutoProb(s: ImageState, timings: Record<string, number>): Promise<GrayImage> {
    if (!s.autoProb) {
      const t0 = now()
      s.autoProb = deps.segment(s.image).then(
        (p) => {
          timings.segment = now() - t0
          s.autoProbValue = p
          return p
        },
        (err) => {
          s.autoProb = null
          throw err
        },
      )
    }
    return s.autoProb
  }

  function ensureLineProb(s: ImageState, timings: Record<string, number>): Promise<GrayImage> {
    if (!s.lineProb) {
      const t0 = now()
      s.lineProb = deps.lineArt(s.image).then(
        (p) => {
          timings.lineArt = now() - t0
          return p
        },
        (err) => {
          s.lineProb = null
          throw err
        },
      )
    }
    return s.lineProb
  }

  /** Subject mask from SAM clicks or the auto segmenter, ignoring keepBackground. */
  async function subjectMask(s: ImageState, timings: Record<string, number>): Promise<MaskInfo> {
    let prob: GrayImage | null = null
    let key = 'none'
    let isSam = false
    if (s.samPoints.length > 0 && s.samProb) {
      prob = s.samProb
      key = `sam${s.samVersion}`
      isSam = true
    } else if (s.samPoints.length === 0 && s.cutout) {
      // A transparent picture already says what the subject is.
      prob = s.cutout
      key = 'cutout'
    } else if (s.samPoints.length === 0) {
      if (!s.autoProbValue && deps.segmenterReady()) {
        try {
          await ensureAutoProb(s, timings)
        } catch (err) {
          deps.onInferenceError?.('segment', err)
        }
      }
      if (s.autoProbValue) {
        prob = s.autoProbValue
        key = 'auto'
      }
    }
    if (!prob) return { mask: null, key: 'none' }
    const p = prob
    const mask = memo(s, 'mask', key, timings, () => cleanMask(p, s.diag, !isSam))
    return mask ? { mask, key } : { mask: null, key: 'none' }
  }

  function outlineOf(s: ImageState, info: MaskInfo, timings: Record<string, number>): Polyline[] {
    if (!info.mask) return []
    const m = info.mask
    return memo(s, 'outline', info.key, timings, () => outerContours(m))
  }

  function finish(
    s: { cache: Map<string, Cached>; width: number; height: number },
    n: number,
    strokes: Polyline[],
    orderKey: string,
    order: () => SinglePath,
    usedLineStyle: LineStyle,
    masked: boolean,
    timings: Record<string, number>,
    t0: number,
  ): PipelineResult {
    const path = memo(s, 'order', orderKey, timings, order)
    if (!hasExtent(path.points)) return emptyResult(s.width, s.height, n, strokes, usedLineStyle, masked, timings, now() - t0)
    const sampleKey = `${orderKey}|${n}`
    const sampled = memo(s, 'resample', sampleKey, timings, () => resample(path, n))
    if (!allFinite(sampled.re) || !allFinite(sampled.im) || !Number.isFinite(sampled.scale))
      return emptyResult(s.width, s.height, n, strokes, usedLineStyle, masked, timings, now() - t0)
    const coeffs = memo(s, 'coeffs', sampleKey, timings, () => computeCoeffs(sampled))
    if (!allFinite(coeffs.re) || !allFinite(coeffs.im))
      return emptyResult(s.width, s.height, n, strokes, usedLineStyle, masked, timings, now() - t0)
    timings.total = now() - t0
    return { width: s.width, height: s.height, strokes, path, sampled, coeffs, usedLineStyle, masked, timings }
  }

  async function run(settings: PipelineSettings): Promise<PipelineResult> {
    const t0 = now()
    const timings: Record<string, number> = {}
    const s = st
    const n = sanitizeSampleCount(settings.sampleCount)
    if (!s) return emptyResult(0, 0, n, [], settings.lineStyle, false, timings, 0)
    const params = deriveParams(settings, s.width, s.height)

    const gray = memo(s, 'gray', '', timings, () => toGray(s.image.data, s.width, s.height))
    const info: MaskInfo = settings.keepBackground ? { mask: null, key: 'none' } : await subjectMask(s, timings)
    const mask = info.mask
    const masked = mask !== null

    if (settings.lineStyle === 'stipple') {
      const count = Math.max(0, Math.floor(settings.stippleCount))
      const dotsKey = `${info.key}|${count}`
      const dots =
        count > 0
          ? memo(s, 'stipple', dotsKey, timings, () =>
              stipple(gray, mask, { count, iterations: STIPPLE_ITERATIONS, seed: 1 }),
            )
          : new Float32Array(0)
      if (dots.length < 4) return emptyResult(s.width, s.height, n, [], 'stipple', masked, timings, now() - t0)
      return finish(s, n, [], `stipple|${dotsKey}`, () => tourPoints(dots), 'stipple', masked, timings, t0)
    }

    let prob: GrayImage | null = null
    if (settings.lineStyle === 'ai' && deps.lineArtReady()) {
      try {
        prob = await ensureLineProb(s, timings)
      } catch (err) {
        deps.onInferenceError?.('lineart', err)
      }
    }
    const style: LineStyle = prob ? 'ai' : 'canny'
    let source: BinaryImage
    let sourceKey: string
    if (prob) {
      const p = prob
      // An await happened: the image may have changed, but s still refers to the one this run started with.
      sourceKey = `ai|${params.lineThreshold}`
      source = memo(s, 'lineThreshold', sourceKey, timings, () => threshold(p, params.lineThreshold))
    } else {
      sourceKey = `canny|${params.cannySigma}|${params.cannyLow}|${params.cannyHigh}`
      source = memo(s, 'canny', sourceKey, timings, () =>
        canny(gray, { sigma: params.cannySigma, low: params.cannyLow, high: params.cannyHigh }),
      )
    }

    let lineKey = sourceKey
    let lines = source
    if (mask) {
      const m = mask
      const r = Math.max(2, Math.round(LINE_MASK_BAND_FRAC * s.diag))
      const outline = settings.includeSilhouette
      const band = memo(s, 'maskBand', `${info.key}|${outline}`, timings, () => (outline ? erode(m, r) : dilate(m, r)))
      lineKey = `${sourceKey}|${info.key}|${outline}`
      const src = source
      lines = memo(s, 'lineMask', lineKey, timings, () => and(src, band))
    }

    const l = lines
    const skel = memo(s, 'thin', lineKey, timings, () => zhangSuen(l))
    const traced = memo(s, 'trace', lineKey, timings, () => traceSkeleton(skel))
    const cleanKey = `${lineKey}|${params.minStrokeLength}|${params.simplifyEpsilon}`
    const lineStrokes = memo(s, 'clean', cleanKey, timings, () =>
      cleanStrokes(traced, params.minStrokeLength, params.simplifyEpsilon),
    )

    let strokes = lineStrokes
    let strokesKey = cleanKey
    if (settings.includeSilhouette && mask) {
      const outline = outlineOf(s, info, timings)
      const silKey = `${info.key}|${params.minStrokeLength}|${params.simplifyEpsilon}`
      const sil = memo(s, 'silhouette', silKey, timings, () =>
        cleanStrokes(trimImageBorder(outline, s.width, s.height), params.minStrokeLength, params.simplifyEpsilon),
      )
      if (sil.length > 0) {
        strokesKey = `${cleanKey}|sil|${silKey}`
        strokes = memo(s, 'strokes', strokesKey, {}, () => lineStrokes.concat(sil))
      }
    }

    if (strokes.length === 0) return emptyResult(s.width, s.height, n, strokes, style, masked, timings, now() - t0)
    const st2 = strokes
    return finish(s, n, strokes, `lines|${strokesKey}`, () => orderStrokes(st2), style, masked, timings, t0)
  }

  return {
    setImage(image, cutout = null) {
      const { width, height } = image
      st = {
        image,
        cutout,
        width,
        height,
        diag: Math.hypot(width, height),
        cache: new Map(),
        autoProb: null,
        autoProbValue: null,
        lineProb: null,
        samPoints: [],
        samProb: null,
        samVersion: 0,
        samSeq: 0,
        samEmbed: null,
      }
      return { width, height }
    },

    async setSamPoints(points) {
      const s = st
      if (!s) return []
      // Take the ticket before any await, so requests resolve in the order they were sent
      // even when the first click has to wait for SAM to download.
      const seq = ++s.samSeq
      const current = () => seq === s.samSeq && st === s
      const pts = points.map((p) => ({ x: p.x, y: p.y, positive: p.positive }))
      if (pts.length === 0) {
        s.samPoints = []
        s.samProb = null
        s.samVersion++
      } else {
        await deps.loadSam?.()
        if (!current()) return st === s ? outlineOf(s, await subjectMask(s, {}), {}) : []
        if (!s.samEmbed) {
          s.samEmbed = deps.samSetImage(s.image).catch((err) => {
            s.samEmbed = null
            throw err
          })
        }
        await s.samEmbed
        const prob = await deps.samPredict(pts)
        // A newer click list or a new image superseded this one while we waited.
        if (!current()) return st === s ? outlineOf(s, await subjectMask(s, {}), {}) : []
        s.samPoints = pts
        s.samProb = prob
        s.samVersion++
      }
      return outlineOf(s, await subjectMask(s, {}), {})
    },

    async getMaskOutline() {
      const s = st
      if (!s) return []
      return outlineOf(s, await subjectMask(s, {}), {})
    },

    run,

    runStrokes(strokes, width, height, sampleCount) {
      const t0 = now()
      const timings: Record<string, number> = {}
      const n = sanitizeSampleCount(sampleCount)
      const w = Number.isFinite(width) ? width : 0
      const h = Number.isFinite(height) ? height : 0
      const valid = strokes.filter((p) => p.length >= 4 && allFinite(p))
      if (valid.length === 0) return emptyResult(w, h, n, valid, 'ai', false, timings, now() - t0)
      // SVG input is a one-off, so its cache is thrown away.
      const s = { cache: new Map<string, Cached>(), width: w, height: h }
      return finish(s, n, valid, 'svg', () => orderStrokes(valid), 'ai', false, timings, t0)
    },

    runPath(path, width, height, sampleCount) {
      const t0 = now()
      const timings: Record<string, number> = {}
      const n = sanitizeSampleCount(sampleCount)
      const s = { cache: new Map<string, Cached>(), width, height }
      if (path.points.length < 4 || !allFinite(path.points)) return emptyResult(width, height, n, [], 'ai', false, timings, 0)
      return finish(s, n, [], 'shared', () => path, 'ai', false, timings, t0)
    },
  }
}

/** threshold -> close -> fill holes (auto masks only) -> drop small blobs. null when nothing is left. */
function cleanMask(prob: GrayImage, diag: number, fill: boolean): BinaryImage | null {
  let m = threshold(prob, MASK_THRESHOLD)
  const r = Math.max(1, Math.round(MASK_CLOSE_FRAC * diag))
  m = close(m, r)
  // SAM negative clicks can carve deliberate holes, so those are left alone.
  if (fill) m = fillHoles(m)
  const largest = largestComponentArea(m)
  if (largest === 0) return null
  return removeSmallComponents(m, Math.max(1, Math.ceil(MASK_MIN_BLOB_FRAC * largest)))
}

/** Area of the largest 8-connected foreground component. */
export function largestComponentArea(bin: BinaryImage): number {
  const { width: w, height: h, data } = bin
  const n = w * h
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  let best = 0
  for (let i = 0; i < n; i++) {
    if (!data[i] || seen[i]) continue
    let top = 0
    let area = 0
    stack[top++] = i
    seen[i] = 1
    while (top > 0) {
      const p = stack[--top]
      area++
      const x = p % w
      const y = (p - x) / w
      const x0 = x > 0 ? x - 1 : x
      const x1 = x < w - 1 ? x + 1 : x
      const y0 = y > 0 ? y - 1 : y
      const y1 = y < h - 1 ? y + 1 : y
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w
        for (let xx = x0; xx <= x1; xx++) {
          const q = row + xx
          if (data[q] && !seen[q]) {
            seen[q] = 1
            stack[top++] = q
          }
        }
      }
    }
    if (area > best) best = area
  }
  return best
}

/** Nearest power of two in [2, 65536]; FFT needs a power of two. */
function sanitizeSampleCount(n: number): number {
  if (!Number.isFinite(n) || n < 2) return 2048
  const p = Math.round(Math.log2(n))
  return 2 ** Math.min(16, Math.max(1, p))
}

function allFinite(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false
  return true
}

/** True when the path has at least two distinct finite points. */
function hasExtent(points: Float32Array): boolean {
  if (points.length < 4 || !allFinite(points)) return false
  const x = points[0]
  const y = points[1]
  for (let i = 2; i < points.length; i += 2) if (points[i] !== x || points[i + 1] !== y) return true
  return false
}

/** Valid result with no drawing: an all-zero spectrum of n terms, so renderers need no special case. */
function emptyResult(
  width: number,
  height: number,
  n: number,
  strokes: Polyline[],
  usedLineStyle: LineStyle,
  masked: boolean,
  timings: Record<string, number>,
  total: number,
): PipelineResult {
  const path: SinglePath = { points: new Float32Array(0), jump: new Uint8Array(0) }
  const sampled: SampledPath = {
    re: new Float64Array(n),
    im: new Float64Array(n),
    jump: new Uint8Array(n),
    scale: 1,
    centerX: width / 2,
    centerY: height / 2,
  }
  const freq = new Int32Array(n)
  for (let k = 0; k < n; k++) freq[k] = k < n / 2 ? k : k - n
  const coeffs: Coeffs = { freq, re: new Float64Array(n), im: new Float64Array(n), amp: new Float64Array(n), n }
  timings.total = total
  return { width, height, strokes, path, sampled, coeffs, usedLineStyle, masked, timings }
}
