import type { GrayImage } from './types'

/** RGBA bytes to luminance in [0, 1]. Pixels with alpha 0 count as white. */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  throw new Error('not implemented')
}

/** Separable Gaussian blur. sigma in pixels; sigma <= 0 returns a copy. */
export function gaussianBlur(img: GrayImage, sigma: number): GrayImage {
  throw new Error('not implemented')
}

/** Bilinear resize. */
export function resizeGray(img: GrayImage, width: number, height: number): GrayImage {
  throw new Error('not implemented')
}
