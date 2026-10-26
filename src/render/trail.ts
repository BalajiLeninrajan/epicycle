/** Anything that takes moveTo/lineTo: a 2D context, a Path2D, or a test recorder. */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
}

/** Number of alpha steps the fade tail is split into. Each step is one stroke. */
export const FADE_BUCKETS = 24

/** Shortest fade tail, as a fraction of the loop. The longest is a whole loop. */
export const MIN_FADE_FRACTION = 0.05

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

/**
 * Adds count consecutive trail points starting at index start (wrapping modulo xs.length),
 * in screen space (ox + x * s, oy + y * s). Each link between neighbouring points goes to
 * `jumps` when either end has jump[i] = 1, else to `main`. When tipX/tipY are given, one
 * more link runs from the last point to the tip, classed like the last point.
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
): void {
  const n = xs.length
  if (n === 0 || count <= 0) return
  const withTip = Number.isFinite(tipX) && Number.isFinite(tipY)
  let i = ((start % n) + n) % n
  let px = ox + xs[i] * s
  let py = oy + ys[i] * s
  let pj = jump !== null && jump[i] === 1
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
    if (pj || fj) {
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

/** Tail length in points for a loop of n points, when the line fades over `fraction` of a loop. */
export function fadeLength(n: number, fraction: number): number {
  const f = Math.min(1, Math.max(MIN_FADE_FRACTION, Number.isFinite(fraction) ? fraction : 1))
  return Math.min(n, Math.max(2, Math.round(n * f)))
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
