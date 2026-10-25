/** Anything that takes moveTo/lineTo: a 2D context, a Path2D, or a test recorder. */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
}

/** Number of alpha steps the fade tail is split into. Each step is one stroke. */
export const FADE_BUCKETS = 8

/** Fade tail length as a fraction of the loop. */
export const FADE_FRACTION = 0.3

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

/**
 * Adds count consecutive trail points starting at index start (wrapping modulo xs.length) to sink,
 * in screen space (ox + x * s, oy + y * s). Points with jump[i] = 1 are skipped and break the line.
 * Returns whether the pen is down at the end, i.e. the last point was drawn.
 */
export function traceTrail(
  sink: PathSink,
  xs: Float64Array,
  ys: Float64Array,
  jump: Uint8Array | null,
  start: number,
  count: number,
  ox: number,
  oy: number,
  s: number,
): boolean {
  const n = xs.length
  if (n === 0 || count <= 0) return false
  let i = ((start % n) + n) % n
  let pen = false
  for (let c = 0; c < count; c++) {
    if (jump !== null && jump[i] === 1) {
      pen = false
    } else {
      const x = ox + xs[i] * s
      const y = oy + ys[i] * s
      if (pen) sink.lineTo(x, y)
      else sink.moveTo(x, y)
      pen = true
    }
    if (++i === n) i = 0
  }
  return pen
}

/** Tail length in points for a loop of n points. */
export function fadeLength(n: number): number {
  return Math.min(n, Math.max(2, Math.round(n * FADE_FRACTION)))
}

/**
 * Offset from the tail start of the first point of bucket b when a tail of len points is split
 * into `buckets` runs. Bucket b spans [bucketStart(b), bucketStart(b + 1)] inclusive, so
 * neighbors share a point and the line stays connected.
 */
export function bucketStart(b: number, buckets: number, len: number): number {
  return Math.floor((b * (len - 1)) / buckets)
}

/** Alpha of bucket b; the oldest bucket (0) is faintest, the newest is opaque. */
export function bucketAlpha(b: number, buckets: number): number {
  return (b + 1) / buckets
}
