import type { GrayImage } from '../pipeline/types'
import type { Backend } from './backend'

/** Load BiRefNet-lite. onProgress gets 0..1. */
export function loadSegmenter(onProgress: (p: number) => void): Promise<Backend> {
  throw new Error('not implemented')
}

/** Foreground probability, same size as the input. */
export function segment(image: ImageData): Promise<GrayImage> {
  throw new Error('not implemented')
}
