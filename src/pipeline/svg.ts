import type { Polyline } from './types'

/** Parse an SVG document (main thread only, needs the DOM) and sample its shapes into polylines. */
export function svgToStrokes(svgText: string): { strokes: Polyline[]; width: number; height: number } {
  void svgText
  throw new Error('not implemented')
}
