import type { Coeffs, SampledPath } from '../pipeline/types'

export interface RenderOptions {
  /** Number of circles K. */
  circles: number
  /** Seconds per full loop. */
  durationSec: number
  showCircles: boolean
  showArrows: boolean
  showTrail: boolean
  trailMode: 'full' | 'fade'
  /** Skip trail segments that lie on connecting jumps. */
  hideJumps: boolean
  /** Camera follows the tip. */
  followTip: boolean
  /** Zoom factor while following. */
  followZoom: number
  lineWidth: number
  playing: boolean
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  circles: 200,
  durationSec: 20,
  showCircles: true,
  showArrows: true,
  showTrail: true,
  trailMode: 'full',
  hideJumps: true,
  followTip: false,
  followZoom: 6,
  lineWidth: 2,
  playing: true,
}

/**
 * Canvas 2D epicycle animation. Colors come from CSS custom properties on the canvas:
 * --fd-bg, --fd-trail, --fd-circle, --fd-arrow.
 */
export class EpicycleRenderer {
  /** Called on every frame with the current t in [0, 1). */
  onTime?: (t: number) => void

  constructor(canvas: HTMLCanvasElement) {
    void canvas
    throw new Error('not implemented')
  }

  setData(coeffs: Coeffs, sampled: SampledPath): void {
    void coeffs, void sampled
    throw new Error('not implemented')
  }

  setOptions(opts: Partial<RenderOptions>): void {
    void opts
    throw new Error('not implemented')
  }

  /** Jump to t in [0, 1). */
  seek(t: number): void {
    void t
    throw new Error('not implemented')
  }

  get time(): number {
    throw new Error('not implemented')
  }

  dispose(): void {
    throw new Error('not implemented')
  }
}
