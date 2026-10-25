import { evalChain, reconstruct } from '../fourier/epicycles'
import type { Coeffs, SampledPath } from '../pipeline/types'
import { newCamera, stepCamera, viewTransform, type View } from './camera'
import { mixRgb, parseRgb, readThemeColors, type ThemeColors } from './theme'
import { FADE_BUCKETS, bucketAlpha, bucketStart, fadeLength, resampleJump, trailSize, traceTrail } from './trail'

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
  circles: 1000,
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

const TAU = 2 * Math.PI
/** Circles and arrows smaller than this (screen px) are skipped. Amplitudes are sorted, so the rest are too. */
const MIN_RADIUS_PX = 0.5
/** Longest frame step; a stalled tab resumes instead of skipping ahead. */
const MAX_DT = 0.1

/**
 * Canvas 2D epicycle animation. Colors come from CSS custom properties on the canvas:
 * --fd-bg, --fd-trail, --fd-circle, --fd-arrow.
 * The canvas must be sized by CSS; the backing store follows its layout size times devicePixelRatio.
 */
export class EpicycleRenderer {
  /** Called on every frame with the current t in [0, 1). */
  onTime?: (t: number) => void

  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private opts: RenderOptions = { ...DEFAULT_RENDER_OPTIONS }
  private coeffs: Coeffs | null = null
  private sampled: SampledPath | null = null
  /** Effective K, clamped to the available terms. */
  private k = 0
  private trailRe: Float64Array = new Float64Array(0)
  private trailIm: Float64Array = new Float64Array(0)
  private trailJump: Uint8Array = new Uint8Array(0)
  private chain = new Float64Array(2)
  /** In [0, 1]; equals 1 only after playOnce finishes. */
  private t = 0
  private raf = 0
  private lastTs = 0
  private dpr = 1
  private colors!: ThemeColors // set by refreshColors() in the constructor
  private colorsDirty = true
  /** Opaque trail color per fade bucket, premixed with the background (see refreshColors). */
  private fadeColors: string[] = []
  private dprQuery: MediaQueryList | null = null
  private readonly cam = newCamera()
  private readonly view: View = { ox: 0, oy: 0, s: 1 }
  private camSettled = true
  private disposed = false
  private onceDone: (() => void) | null = null
  private readonly ro: ResizeObserver
  private readonly darkQuery: MediaQueryList | null

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('EpicycleRenderer: 2D canvas context unavailable')
    this.canvas = canvas
    this.ctx = ctx
    this.refreshColors()
    this.watchDpr()

    this.ro = new ResizeObserver(this.onResize)
    try {
      this.ro.observe(canvas, { box: 'device-pixel-content-box' })
    } catch {
      this.ro.observe(canvas)
    }
    document.addEventListener('visibilitychange', this.onVisibility)
    this.darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    this.darkQuery?.addEventListener('change', this.onScheme)
    this.requestDraw()
  }

  setData(coeffs: Coeffs, sampled: SampledPath): void {
    this.coeffs = coeffs
    this.sampled = sampled
    this.trailJump = resampleJump(sampled.jump, trailSize(sampled.re.length))
    this.k = -1
    this.updateTrail()
    this.requestDraw()
  }

  setOptions(opts: Partial<RenderOptions>): void {
    const next = { ...this.opts, ...opts }
    if (!(next.durationSec > 0)) next.durationSec = DEFAULT_RENDER_OPTIONS.durationSec
    if (!(next.followZoom > 0)) next.followZoom = DEFAULT_RENDER_OPTIONS.followZoom
    if (!next.playing && this.opts.playing) this.finishOnce()
    if (next.playing && !this.opts.playing && this.t >= 1) this.t = 0
    this.opts = next
    if (opts.circles !== undefined) this.updateTrail()
    this.requestDraw()
  }

  /** Current options (read only; change them with setOptions). */
  get options(): Readonly<RenderOptions> {
    return this.opts
  }

  /** Jump to t in [0, 1). */
  seek(t: number): void {
    this.t = Number.isFinite(t) ? t - Math.floor(t) : 0
    this.requestDraw()
  }

  get time(): number {
    return this.t < 1 ? this.t : 0
  }

  /**
   * Plays from t = 0 to exactly t = 1 (the full closed trail) and stops there. Resolves at the end,
   * or early when paused or disposed. Used for recording.
   */
  playOnce(): Promise<void> {
    this.finishOnce()
    this.t = 0
    this.lastTs = 0
    this.opts = { ...this.opts, playing: true }
    const done = new Promise<void>((resolve) => (this.onceDone = resolve))
    this.requestDraw()
    return done
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.ro.disconnect()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.darkQuery?.removeEventListener('change', this.onScheme)
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.finishOnce()
  }

  private finishOnce(): void {
    const done = this.onceDone
    this.onceDone = null
    done?.()
  }

  private updateTrail(): void {
    const coeffs = this.coeffs
    const sampled = this.sampled
    if (coeffs === null || sampled === null) return
    const k = Math.max(0, Math.min(Math.floor(this.opts.circles), coeffs.freq.length))
    if (k === this.k) return
    this.k = k
    const trail = reconstruct(coeffs, k, trailSize(sampled.re.length))
    this.trailRe = trail.re
    this.trailIm = trail.im
    if (this.chain.length < 2 * (k + 1)) this.chain = new Float64Array(2 * (k + 1))
  }

  private requestDraw(): void {
    if (this.disposed || this.raf !== 0 || document.hidden) return
    this.raf = requestAnimationFrame(this.frame)
  }

  private readonly frame = (ts: number): void => {
    this.raf = 0
    if (this.disposed) return
    const dt = this.lastTs > 0 ? Math.min(MAX_DT, (ts - this.lastTs) / 1000) : 0
    this.lastTs = ts
    const active = this.coeffs !== null
    if (active && this.opts.playing) {
      this.t += dt / this.opts.durationSec
      if (this.t >= 1) {
        if (this.onceDone !== null) {
          this.t = 1
          this.opts = { ...this.opts, playing: false }
        } else {
          this.t -= Math.floor(this.t)
        }
      }
    }
    this.render(dt)
    this.onTime?.(this.t < 1 ? this.t : 1 - 1e-9)
    if (this.t >= 1) this.finishOnce()
    if (active && (this.opts.playing || !this.camSettled)) this.requestDraw()
    else this.lastTs = 0
  }

  private readonly onResize = (entries: ResizeObserverEntry[]): void => {
    const entry = entries[entries.length - 1]
    if (entry === undefined) return
    this.dpr = window.devicePixelRatio || 1
    const box = entry.devicePixelContentBoxSize?.[0]
    const w = box ? box.inlineSize : Math.round(entry.contentRect.width * this.dpr)
    const h = box ? box.blockSize : Math.round(entry.contentRect.height * this.dpr)
    if (w === this.canvas.width && h === this.canvas.height) return
    this.canvas.width = w
    this.canvas.height = h
    // Resizing clears the canvas; redraw now so nothing flashes before the next frame.
    this.render(0)
  }

  /**
   * Translucent bucket strokes would overlap at their shared endpoints and leave brighter
   * beads along the tail, so each bucket gets an opaque color mixed over the background.
   */
  private refreshColors(): void {
    this.colors = readThemeColors(this.canvas)
    this.colorsDirty = false
    const fg = parseRgb(this.ctx, this.colors.trail)
    const bg = parseRgb(this.ctx, this.colors.bg)
    this.fadeColors = []
    for (let b = 0; b < FADE_BUCKETS; b++) {
      this.fadeColors.push(fg && bg ? mixRgb(fg, bg, bucketAlpha(b, FADE_BUCKETS)) : this.colors.trail)
    }
  }

  /**
   * devicePixelRatio can change without a size change (moving to another monitor, zoom),
   * which the ResizeObserver doesn't report. A resolution media query fires on that.
   */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.dprQuery = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null
    this.dprQuery?.addEventListener('change', this.onDprChange)
  }

  private readonly onDprChange = (): void => {
    if (this.disposed) return
    this.dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.round(rect.width * this.dpr)
    this.canvas.height = Math.round(rect.height * this.dpr)
    this.watchDpr()
    this.render(0)
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      if (this.raf !== 0) cancelAnimationFrame(this.raf)
      this.raf = 0
      this.lastTs = 0
    } else {
      this.requestDraw()
    }
  }

  private readonly onScheme = (): void => {
    this.colorsDirty = true
    this.requestDraw()
  }

  private render(dt: number): void {
    const ctx = this.ctx
    const w = this.canvas.width
    const h = this.canvas.height
    if (this.colorsDirty) this.refreshColors()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = this.colors.bg
    ctx.fillRect(0, 0, w, h)

    const coeffs = this.coeffs
    if (coeffs === null || w === 0 || h === 0) {
      this.camSettled = true
      return
    }

    const k = this.k
    const chain = this.chain
    evalChain(coeffs, k, this.t, chain)
    const tipX = chain[2 * k]
    const tipY = chain[2 * k + 1]
    this.camSettled = stepCamera(this.cam, this.opts.followTip, this.opts.followZoom, dt)
    const view = viewTransform(w, h, this.cam, tipX, tipY, this.view)
    const tipSx = view.ox + tipX * view.s
    const tipSy = view.oy + tipY * view.s

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (this.opts.showTrail) this.drawTrail(view, tipSx, tipSy)
    if (this.opts.showCircles) this.drawCircles(coeffs, view, w, h)
    if (this.opts.showArrows) this.drawArrows(coeffs, view, tipSx, tipSy)
  }

  private drawTrail(view: View, tipSx: number, tipSy: number): void {
    const ctx = this.ctx
    const xs = this.trailRe
    const ys = this.trailIm
    const n = xs.length
    if (n === 0) return
    const jump = this.opts.hideJumps ? this.trailJump : null
    const { ox, oy, s } = view
    // Last trail sample at or before t; m = n closes the loop back to sample 0.
    const m = Math.min(n, Math.floor(this.t * n))
    ctx.strokeStyle = this.colors.trail
    ctx.lineWidth = this.opts.lineWidth * this.dpr

    if (this.opts.trailMode === 'full') {
      ctx.beginPath()
      const pen = traceTrail(ctx, xs, ys, jump, 0, m + 1, ox, oy, s)
      if (pen && m < n) ctx.lineTo(tipSx, tipSy)
      ctx.stroke()
      return
    }

    const len = fadeLength(n)
    const start = m - len + 1
    for (let b = 0; b < FADE_BUCKETS; b++) {
      const s0 = bucketStart(b, FADE_BUCKETS, len)
      const s1 = b === FADE_BUCKETS - 1 ? len - 1 : bucketStart(b + 1, FADE_BUCKETS, len)
      if (s1 <= s0 && b < FADE_BUCKETS - 1) continue
      ctx.beginPath()
      const pen = traceTrail(ctx, xs, ys, jump, start + s0, s1 - s0 + 1, ox, oy, s)
      if (pen && b === FADE_BUCKETS - 1 && m < n) ctx.lineTo(tipSx, tipSy)
      ctx.strokeStyle = this.fadeColors[b] ?? this.colors.trail
      ctx.stroke()
    }
  }

  private drawCircles(coeffs: Coeffs, view: View, w: number, h: number): void {
    const ctx = this.ctx
    const chain = this.chain
    const amp = coeffs.amp
    const { ox, oy, s } = view
    ctx.beginPath()
    for (let i = 0; i < this.k; i++) {
      const r = amp[i] * s
      if (r < MIN_RADIUS_PX) break
      const x = ox + chain[2 * i] * s
      const y = oy + chain[2 * i + 1] * s
      if (x + r < 0 || x - r > w || y + r < 0 || y - r > h) continue
      // A circle enclosing the whole viewport draws nothing visible.
      const dx = Math.max(x, w - x)
      const dy = Math.max(y, h - y)
      if (dx * dx + dy * dy < r * r) continue
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, TAU)
    }
    ctx.strokeStyle = this.colors.circle
    ctx.lineWidth = this.dpr
    ctx.stroke()
  }

  private drawArrows(coeffs: Coeffs, view: View, tipSx: number, tipSy: number): void {
    const ctx = this.ctx
    const chain = this.chain
    const amp = coeffs.amp
    const { ox, oy, s } = view
    ctx.beginPath()
    ctx.moveTo(ox + chain[0] * s, oy + chain[1] * s)
    let i = 0
    for (; i < this.k; i++) {
      if (amp[i] * s < MIN_RADIUS_PX) break
      ctx.lineTo(ox + chain[2 * i + 2] * s, oy + chain[2 * i + 3] * s)
    }
    // The skipped sub-pixel arrows still add up; finish the chain at the tip.
    if (i < this.k) ctx.lineTo(tipSx, tipSy)
    ctx.strokeStyle = this.colors.arrow
    ctx.lineWidth = 1.25 * this.dpr
    ctx.stroke()
  }
}
