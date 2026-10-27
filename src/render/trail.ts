/** Anything that takes moveTo/lineTo: a 2D context, a Path2D, or a test recorder. */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
}

/** Number of alpha steps the fade tail is split into. Each step is one stroke. */
export const FADE_BUCKETS = 24

/** Shortest and longest fade tail, in loops. Past one loop the tail wraps over the drawing. */
export const MIN_FADE_FRACTION = 0.05
export const MAX_FADE_FRACTION = 4

/** Opacity of connecting jumps relative to the drawing around them. */
export const JUMP_ALPHA = 0.25

/** Smallest power of 2 >= n (and >= 2), the resolution reconstruct needs. */
export function trailSize(n: number): number {
  let p = 2
  while (p < n) p <<= 1
  return p
}

/** jump flags resampled to n entries by nearest earlier index. Returns the input when sizes match. */
export function resampleJump(jump: Uint8Array, n: number): Uint8Array {
  if (jump.length === n) return jump
  const out = new Uint8Array(n)
  const m = jump.length
  if (m === 0) return out
  for (let j = 0; j < n; j++) out[j] = jump[Math.floor((j * m) / n)]
  return out
}

/** Discards everything; trace into it to draw only the other kind of link. */
export const NO_SINK: PathSink = { moveTo() {}, lineTo() {} }

/** Viewport for traceTrail: links entirely past one edge, by more than margin, are left out. */
export interface TraceClip {
  width: number
  height: number
  /** How far outside the viewport a link may lie and still reach it, e.g. the line width. */
  margin: number
}

/**
 * Adds count consecutive trail points starting at index start (wrapping modulo xs.length),
 * in screen space (ox + x * s, oy + y * s). Each link between neighbouring points goes to
 * `jumps` when either end has jump[i] = 1, else to `main`. When tipX/tipY are given, one
 * more link runs from the last point to the tip, classed like the last point. With clip,
 * links that can't reach the viewport are left out.
 */
export function traceTrail(
  main: PathSink,
  jumps: PathSink,
  xs: Float64Array,
  ys: Float64Array,
  jump: Uint8Array | null,
  start: number,
  count: number,
  ox: number,
  oy: number,
  s: number,
  tipX = Number.NaN,
  tipY = Number.NaN,
  clip: TraceClip | null = null,
): void {
  const n = xs.length
  if (n === 0 || count <= 0) return
  const withTip = Number.isFinite(tipX) && Number.isFinite(tipY)
  let i = ((start % n) + n) % n
  let px = ox + xs[i] * s
  let py = oy + ys[i] * s
  let pj = jump !== null && jump[i] === 1
  const x0 = clip ? -clip.margin : Number.NEGATIVE_INFINITY
  const y0 = clip ? -clip.margin : Number.NEGATIVE_INFINITY
  const x1 = clip ? clip.width + clip.margin : Number.POSITIVE_INFINITY
  const y1 = clip ? clip.height + clip.margin : Number.POSITIVE_INFINITY
  // Index of the point each pen rests on, so consecutive links stay one subpath.
  let mainAt = -1
  let jumpAt = -1
  const links = withTip ? count : count - 1
  for (let c = 1; c <= links; c++) {
    let x: number
    let y: number
    let fj: boolean
    if (c < count) {
      if (++i === n) i = 0
      x = ox + xs[i] * s
      y = oy + ys[i] * s
      fj = jump !== null && jump[i] === 1
    } else {
      x = tipX
      y = tipY
      fj = pj
    }
    // A link wholly past one edge can't show; skipping it breaks the subpath there.
    const off = (px < x0 && x < x0) || (px > x1 && x > x1) || (py < y0 && y < y0) || (py > y1 && y > y1)
    if (off) {
      // Leave both pens where they are; the next link drawn starts a new subpath.
    } else if (pj || fj) {
      if (jumpAt !== c - 1) jumps.moveTo(px, py)
      jumps.lineTo(x, y)
      jumpAt = c
    } else {
      if (mainAt !== c - 1) main.moveTo(px, py)
      main.lineTo(x, y)
      mainAt = c
    }
    px = x
    py = y
    pj = fj
  }
}

/** Tail length in points for a loop of n points, when the line fades over `fraction` loops. */
export function fadeLength(n: number, fraction: number): number {
  const f = Math.min(MAX_FADE_FRACTION, Math.max(MIN_FADE_FRACTION, Number.isFinite(fraction) ? fraction : 1))
  return Math.min(Math.round(n * MAX_FADE_FRACTION), Math.max(2, Math.round(n * f)))
}

/**
 * Offset from the tail start of the first point of bucket b when a tail of len points is split
 * into `buckets` runs. Bucket b spans [bucketStart(b), bucketStart(b + 1)] inclusive, so
 * neighbors share a point and the line stays connected.
 */
export function bucketStart(b: number, buckets: number, len: number): number {
  return Math.floor((b * (len - 1)) / buckets)
}

/** Alpha of bucket b; the oldest bucket (0) is faintest, the newest is opaque. Eased so most of the tail stays readable. */
export function bucketAlpha(b: number, buckets: number): number {
  return ((b + 1) / buckets) ** 1.6
}
