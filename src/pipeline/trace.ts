import type { BinaryImage, Polyline } from './types'

/**
 * Split a 1px skeleton into polylines at endpoints and junctions.
 * Isolated loops become closed polylines. Pixel centers are used as coordinates.
 */
export function traceSkeleton(skel: BinaryImage): Polyline[] {
  throw new Error('not implemented')
}

/** Ramer-Douglas-Peucker simplification. Keeps first and last points. */
export function rdp(poly: Polyline, epsilon: number): Polyline {
  throw new Error('not implemented')
}

export function polylineLength(poly: Polyline): number {
  throw new Error('not implemented')
}

/** Drop polylines shorter than minLength and simplify the rest. */
export function cleanStrokes(strokes: Polyline[], minLength: number, epsilon: number): Polyline[] {
  throw new Error('not implemented')
}
