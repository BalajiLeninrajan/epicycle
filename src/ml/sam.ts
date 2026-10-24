import type { GrayImage, SamPoint } from '../pipeline/types'
import type { Backend } from './backend'

/** Load SlimSAM. onProgress gets 0..1. */
export function loadSam(onProgress: (p: number) => void): Promise<Backend> {
  throw new Error('not implemented')
}

/** Compute and cache image embeddings. */
export function samSetImage(image: ImageData): Promise<void> {
  throw new Error('not implemented')
}

/** Mask probability for the clicks, same size as the image passed to samSetImage. */
export function samPredict(points: SamPoint[]): Promise<GrayImage> {
  throw new Error('not implemented')
}
