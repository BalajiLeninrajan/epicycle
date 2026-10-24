import type { BinaryImage, GrayImage, SinglePath } from './types'

export interface StippleOptions {
  count: number
  /** Lloyd relaxation iterations. */
  iterations: number
  seed?: number
}

/** Weighted Voronoi stippling. Darker pixels get more dots. Returns interleaved xy in pixel space. */
export function stipple(gray: GrayImage, mask: BinaryImage | null, opts: StippleOptions): Float32Array {
  throw new Error('not implemented')
}

/** TSP tour through the points (nearest-neighbor + 2-opt). No jumps flagged. */
export function tourPoints(points: Float32Array, timeBudgetMs?: number): SinglePath {
  throw new Error('not implemented')
}
