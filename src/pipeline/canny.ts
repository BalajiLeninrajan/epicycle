import type { BinaryImage, GrayImage } from './types'

export interface CannyOptions {
  /** Gaussian blur sigma applied first. */
  sigma: number
  /** Hysteresis thresholds as fractions of the maximum gradient magnitude, 0..1. */
  low: number
  high: number
}

/** Canny edge detector: blur, Sobel, non-maximum suppression, hysteresis. 1 = edge. */
export function canny(gray: GrayImage, opts: CannyOptions): BinaryImage {
  throw new Error('not implemented')
}
