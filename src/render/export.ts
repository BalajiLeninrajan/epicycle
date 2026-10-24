import type { Coeffs, SampledPath, SinglePath } from '../pipeline/types'
import type { EpicycleRenderer, RenderOptions } from './epicycles'

/** Render the finished drawing (full trail, no circles) to a PNG at the given size. */
export function exportPng(coeffs: Coeffs, sampled: SampledPath, opts: RenderOptions, size: number): Promise<Blob> {
  void coeffs, void sampled, void opts, void size
  throw new Error('not implemented')
}

/** Record one full loop of the live canvas as WebM. */
export function recordWebm(canvas: HTMLCanvasElement, renderer: EpicycleRenderer, fps?: number): Promise<Blob> {
  void canvas, void renderer, void fps
  throw new Error('not implemented')
}

/** The single-line path as an SVG document. Jump segments are omitted when hideJumps is true. */
export function pathToSvg(path: SinglePath, width: number, height: number, hideJumps: boolean): string {
  void path, void width, void height, void hideJumps
  throw new Error('not implemented')
}
