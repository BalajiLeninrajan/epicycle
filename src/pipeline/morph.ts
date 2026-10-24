import type { BinaryImage, GrayImage } from './types'

/** 1 where gray >= t (or gray < t when invert is true). */
export function threshold(gray: GrayImage, t: number, invert?: boolean): BinaryImage {
  throw new Error('not implemented')
}

/** Dilation with a disk of radius r. */
export function dilate(bin: BinaryImage, r: number): BinaryImage {
  throw new Error('not implemented')
}

/** Erosion with a disk of radius r. */
export function erode(bin: BinaryImage, r: number): BinaryImage {
  throw new Error('not implemented')
}

/** Morphological close (dilate then erode). */
export function close(bin: BinaryImage, r: number): BinaryImage {
  throw new Error('not implemented')
}

/** Remove 8-connected foreground components smaller than minArea pixels. */
export function removeSmallComponents(bin: BinaryImage, minArea: number): BinaryImage {
  throw new Error('not implemented')
}

/** Fill background regions not connected to the image border. */
export function fillHoles(bin: BinaryImage): BinaryImage {
  throw new Error('not implemented')
}

/** Pixelwise AND. Sizes must match. */
export function and(a: BinaryImage, b: BinaryImage): BinaryImage {
  throw new Error('not implemented')
}
