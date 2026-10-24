import type { GrayImage } from '../pipeline/types'
import type { Backend } from './backend'

/** Load Informative Drawings (line art). onProgress gets 0..1. */
export function loadLineArt(onProgress: (p: number) => void): Promise<Backend> {
  throw new Error('not implemented')
}

/** Line drawing, same size as the input. 1 = ink, 0 = paper. */
export function lineArt(image: ImageData): Promise<GrayImage> {
  throw new Error('not implemented')
}
