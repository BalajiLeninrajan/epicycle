import type { Polyline, SinglePath } from './types'

export interface OrderOptions {
  /** Max 2-opt passes. */
  maxPasses?: number
  /** Time budget for improvement in ms. */
  timeBudgetMs?: number
}

/**
 * Join strokes into one closed path that keeps jumps short.
 * Each stroke may be walked in either direction; closed strokes may be entered at any vertex.
 * Nearest-neighbor construction, then 2-opt with direction flips.
 */
export function orderStrokes(strokes: Polyline[], opts?: OrderOptions): SinglePath {
  throw new Error('not implemented')
}
