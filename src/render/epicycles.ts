import { evalChain, reconstruct } from '../fourier/epicycles'
import type { Coeffs, SampledPath } from '../pipeline/types'
import { fitScale, newCamera, smoothing, stepCamera, viewTransform, type View } from './camera'
import { mixRgb, parseRgb, readThemeColors, type ThemeColors } from './theme'
import {
  FADE_BUCKETS,
  JUMP_ALPHA,
  MAX_FADE_FRACTION,
  bucketAlpha,
  bucketStart,
  fadeLength,
  resampleJump,
  trailSize,
  traceTrail,
  type TraceClip,
} from './trail'

export interface RenderOptions {
  /** Number of circles K. */
  circles: number
  /** Seconds per full loop. */
  durationSec: number
  showCircles: boolean
  showArrows: boolean
  showTrail: boolean
  /** 'fade': the line fades with age, like 3Blue1Brown's. 'full': the drawing stays. */
  trailMode: 'full' | 'fade'
  /** In fade mode, how many loops it takes the line to fade out (MIN_FADE_FRACTION to MAX_FADE_FRACTION). */
  fadeFraction: number
  /** Camera follows the tip. */
  followTip: boolean
  /** Zoom factor while following. */
  followZoom: number
  /** Partial follow in [0, 1] at followZoom; overrides followTip when set. */
  followAmount?: number
  /** Playback speed multiplier (1 = durationSec per loop). */
  timeScale?: number
  /**
   * Smooth follow: the camera drifts after the tip instead of locking onto it. It stays put
   * while the tip is within camDeadZone (fraction of the short side) of the centre, eases
   * toward it otherwise, and never moves faster than camMaxSpeed CSS px per second.
   */
  camMaxSpeed?: number
  camDeadZone?: number
  /** Arrow line width in CSS px (default 1.25). */
  arrowWidth?: number
  lineWidth: number
  playing: boolean
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  circles: 1000,
  durationSec: 20,
  showCircles: true,
  showArrows: true,
  showTrail: true,
  trailMode: 'fade',
  fadeFraction: 1,
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
/** Past this many screen pixels between stored trail samples, the trail near the tip is evaluated directly. */
const FINE_SPACING_PX = 3
/** Screen pixels between points of the directly evaluated trail. */
const FINE_STEP_PX = 8
/** How much of the screen diagonal the fine trail covers on each side of the tip. */
const FINE_REACH = 0.75

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
  /** Length of one loop of the trail, in world units. */
  private trailLength = 0
  /** Scratch for the fine trail: per-term phasors and per-step rotations. */
  private fineZ = new Float64Array(0)
  private fineR = new Float64Array(0)
  /**
   * Points of the series at t = j * fineDt for j in [fineJ0, fineJ0 + fineN), in world units.
   * The tip moves a few pixels a frame, so most frames only add a point or two.
   */
  private fineDt = 0
  private fineJ0 = 0
  private fineN = 0
  private fineX = new Float64Array(0)
  private fineY = new Float64Array(0)
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
  /** Same, for connecting jumps, which draw at JUMP_ALPHA of the line around them. */
  private fadeJumpColors: string[] = []
  private jumpColor = ''
  /** Completed loops since the data was set (capped), so the fade tail knows how far back the line exists. */
  private loops = 0
  private dprQuery: MediaQueryList | null = null
  private readonly cam = newCamera()
  private readonly view: View = { ox: 0, oy: 0, s: 1 }
  /** Smooth-follow camera centre (world units) and velocity (world units per second). */
  private camX = 0
  private camY = 0
  private camVX = 0
  private camVY = 0
  /** Scale the smooth-follow camera last ran at, so a zoom change can keep the tip where it is on screen. */
  private camS = 0
  private readonly clip: TraceClip = { width: 0, height: 0, margin: 0 }
  /**
   * In Full mode, once the first loop is done and the camera is at rest, the drawing stops
   * changing. It's stroked once into this layer and copied every frame after that.
   */
  private layer: HTMLCanvasElement | null = null
  /** The view and line width the layer was drawn with; empty when it's stale. */
  private layerKey = ''
  private camSettled = true
  private disposed = false
  private onceDone: (() => void) | null = null
  private readonly ro: ResizeObserver
  private readonly darkQuery: MediaQueryList | null

  constructor(canvas: HTMLCanvasElement) {
    // Every frame fills the background, so the canvas can be opaque and skip blending with the page.
    const ctx = canvas.getContext('2d', { alpha: false })
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
    this.loops = 0
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
    if (next.trailMode !== 'full') this.layer = null
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
    this.loops = 0
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
    this.layer = null
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
    let len = 0
    for (let i = 0, n = trail.re.length; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0
      len += Math.hypot(trail.re[j] - trail.re[i], trail.im[j] - trail.im[i])
    }
    this.trailLength = len
    this.fineN = 0
    this.layerKey = ''
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
      this.t += (dt * (this.opts.timeScale ?? 1)) / this.opts.durationSec
      if (this.t >= 1) {
        if (this.onceDone !== null) {
          this.t = 1
          this.opts = { ...this.opts, playing: false }
        } else {
          this.t -= Math.floor(this.t)
          this.loops = Math.min(this.loops + 1, MAX_FADE_FRACTION + 1)
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
    this.layerKey = ''
    const fg = parseRgb(this.ctx, this.colors.trail)
    const bg = parseRgb(this.ctx, this.colors.bg)
    const mix = (a: number) => (fg && bg ? mixRgb(fg, bg, a) : this.colors.trail)
    this.fadeColors = []
    this.fadeJumpColors = []
    for (let b = 0; b < FADE_BUCKETS; b++) {
      this.fadeColors.push(mix(bucketAlpha(b, FADE_BUCKETS)))
      this.fadeJumpColors.push(mix(bucketAlpha(b, FADE_BUCKETS) * JUMP_ALPHA))
    }
    this.jumpColor = mix(JUMP_ALPHA)
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
    // Keep this even though the fill covers everything: Chromium drops the previous frame's
    // queued draws on a full clearRect but not on an opaque fillRect. Without it a frame went
    // from ~5 ms to ~70 ms on an Intel iGPU.
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
    this.camSettled = stepCamera(this.cam, this.opts.followAmount ?? this.opts.followTip, this.opts.followZoom, dt)
    const view = this.opts.camMaxSpeed === undefined ? viewTransform(w, h, this.cam, tipX, tipY, this.view) : this.smoothView(w, h, tipX, tipY, dt)
    const tipSx = view.ox + tipX * view.s
    const tipSy = view.oy + tipY * view.s

    ctx.lineCap = 'round'
    // Trail segments are about a pixel long, too short for the join style to show, and
    // round joins cost the most to tessellate.
    ctx.lineJoin = 'bevel'
    if (this.opts.showTrail) this.drawTrail(view, tipSx, tipSy)
    ctx.lineJoin = 'round'
    if (this.opts.showCircles) this.drawCircles(coeffs, view, w, h)
    if (this.opts.showArrows) this.drawArrows(coeffs, view, tipSx, tipSy)
  }

  /** View for smooth follow: the centre chases follow * tip with a dead zone, eased acceleration and a speed cap. */
  private smoothView(w: number, h: number, tipX: number, tipY: number, dt: number): View {
    const s = fitScale(w, h) * this.cam.zoom
    const tx = this.cam.follow * tipX
    const ty = this.cam.follow * tipY
    // Zooming keeps the camera's lag the same in screen pixels, not world units. Otherwise lag
    // picked up zoomed out turns into tens of thousands of pixels zoomed in, and the capped
    // camera takes minutes to catch up.
    if (this.camS > 0 && s > 0 && s !== this.camS) {
      const k = this.camS / s
      this.camX = tx - (tx - this.camX) * k
      this.camY = ty - (ty - this.camY) * k
      this.camVX *= k
      this.camVY *= k
    }
    this.camS = s
    if (s > 0 && dt > 0) {
      const dx = (tx - this.camX) * s
      const dy = (ty - this.camY) * s
      const dist = Math.hypot(dx, dy)
      const dead = (this.opts.camDeadZone ?? 0) * Math.min(w, h)
      const max = (this.opts.camMaxSpeed ?? Infinity) * this.dpr
      // Wanted screen velocity: close the distance past the dead zone in about a quarter second.
      let vx = 0
      let vy = 0
      if (dist > dead) {
        const want = Math.min(max, (dist - dead) * 4)
        vx = (dx / dist) * want
        vy = (dy / dist) * want
      }
      const a = smoothing(dt, 6)
      let cvx = this.camVX * s + (vx - this.camVX * s) * a
      let cvy = this.camVY * s + (vy - this.camVY * s) * a
      const sp = Math.hypot(cvx, cvy)
      if (sp > max) {
        cvx *= max / sp
        cvy *= max / sp
      }
      this.camVX = cvx / s
      this.camVY = cvy / s
      this.camX += this.camVX * dt
      this.camY += this.camVY * dt
    }
    this.view.s = s
    this.view.ox = w / 2 - this.camX * s
    this.view.oy = h / 2 - this.camY * s
    return this.view
  }

  private drawTrail(view: View, tipSx: number, tipSy: number): void {
    const n = this.trailRe.length
    if (n === 0) return
    // Last trail sample at or before t; m = n closes the loop back to sample 0.
    const m = Math.min(n, Math.floor(this.t * n))
    const tipX = m < n ? tipSx : Number.NaN
    const tipY = m < n ? tipSy : Number.NaN
    this.ctx.lineWidth = this.opts.lineWidth * this.dpr
    this.clip.width = this.canvas.width
    this.clip.height = this.canvas.height
    this.clip.margin = this.ctx.lineWidth

    if (this.opts.trailMode === 'full') {
      // After the first loop the whole drawing stays up. With the camera at rest it doesn't move either.
      if (this.loops === 0) this.strokeRun(this.ctx, view, 0, m + 1, tipX, tipY, this.colors.trail, this.jumpColor)
      else if (this.cam.follow === 0) this.drawLayer(view, n)
      else this.strokeRun(this.ctx, view, 0, n + 1, Number.NaN, Number.NaN, this.colors.trail, this.jumpColor)
      return
    }

    // The tail ending at the tip, split into buckets by age. It can be longer than a loop, in
    // which case it wraps over itself and newer passes are drawn on top. Points from before the
    // drawing started haven't been drawn yet and are skipped.
    const len = fadeLength(n, this.opts.fadeFraction)
    const start = m - len + 1
    const first = Math.max(0, len - 1 - (this.loops * n + m))

    // Zoomed in far enough that trail samples sit more than a few pixels apart, the stored trail
    // turns into straight chords. Around the tip it's replaced by one evaluated from the series
    // at screen resolution: behind the tip (just drawn) and ahead of it (the previous loop).
    const spacing = (this.trailLength / n) * view.s
    let dn = 0
    let window = 0
    if (spacing > FINE_SPACING_PX && this.trailLength > 0) {
      window = (FINE_REACH * Math.hypot(this.canvas.width, this.canvas.height)) / (view.s * this.trailLength)
      dn = Math.min(Math.floor(n / 4), Math.ceil(window * n) + 1)
      window = Math.min(window, dn / n)
    }
    const tailEnd = len - 1 - dn // last offset the stored trail draws up to
    const aheadFrom = len - n // offsets [aheadFrom, aheadFrom + dn) are the previous loop just ahead of the tip
    const aheadTo = aheadFrom + dn - 1
    const runs: [number, number][] = []
    for (let b = 0; b < FADE_BUCKETS; b++) {
      const last = b === FADE_BUCKETS - 1
      const s0 = Math.max(bucketStart(b, FADE_BUCKETS, len), first)
      let s1 = last ? len - 1 : bucketStart(b + 1, FADE_BUCKETS, len)
      if (dn > 0) s1 = Math.min(s1, tailEnd)
      if (s1 < s0 || (s1 === s0 && !(last && dn === 0))) continue
      runs.length = 0
      if (dn > 0 && aheadTo >= s0 && aheadFrom <= s1) {
        if (aheadFrom - 1 >= s0) runs.push([s0, aheadFrom - 1])
        if (aheadTo + 1 <= s1) runs.push([aheadTo + 1, s1])
      } else {
        runs.push([s0, s1])
      }
      for (const [r0, r1] of runs) {
        const toTip = last && dn === 0 && r1 === len - 1
        this.strokeRun(
          this.ctx,
          view,
          start + r0,
          r1 - r0 + 1,
          toTip ? tipX : Number.NaN,
          toTip ? tipY : Number.NaN,
          this.fadeColors[b] ?? this.colors.trail,
          this.fadeJumpColors[b] ?? this.jumpColor,
        )
      }
    }
    if (dn === 0) return

    const t = this.t
    const B = FADE_BUCKETS
    // Behind the tip, newest color. Before the first loop has gone round, nothing exists before t = 0.
    const behind0 = this.loops === 0 ? Math.max(0, t - window) : t - window
    this.fillFine(view, t - window, t + window)
    if (t > behind0) this.strokeFine(view, behind0, t, this.fadeColors[B - 1], this.fadeJumpColors[B - 1])
    // Ahead of the tip: what the previous loop drew there, if it's still on screen.
    if (aheadTo >= first && aheadFrom >= 0) {
      const b = Math.min(B - 1, Math.floor(((aheadFrom + dn / 2) * B) / Math.max(1, len - 1)))
      this.strokeFine(view, t, t + window, this.fadeColors[b], this.fadeJumpColors[b])
    }
  }

  /**
   * Make sure the fine cache holds every grid point in [t0, t1]. The grid step follows the zoom
   * (about FINE_STEP_PX on screen) but is only reset when it's off by more than about 2x, so
   * zooming doesn't recompute every frame.
   */
  private fillFine(view: View, t0: number, t1: number): void {
    const want = FINE_STEP_PX / (this.trailLength * view.s)
    if (!(this.fineDt > 0) || this.fineDt > want * 1.6 || this.fineDt < want / 2.5) {
      this.fineDt = want
      this.fineN = 0
    }
    const dt = this.fineDt
    const ja = Math.floor(t0 / dt)
    const jb = Math.ceil(t1 / dt)
    const count = jb - ja + 1
    if (count > 20000) return
    const xs = count <= this.fineX.length ? this.fineX : new Float64Array(count * 2)
    const ys = count <= this.fineY.length ? this.fineY : new Float64Array(count * 2)
    // Keep the overlap with what's cached, shifted to the new start.
    const o0 = Math.max(ja, this.fineJ0)
    const o1 = Math.min(jb, this.fineJ0 + this.fineN - 1)
    if (this.fineN > 0 && o1 >= o0) {
      const tx = Float64Array.from(this.fineX.subarray(o0 - this.fineJ0, o1 - this.fineJ0 + 1))
      const ty = Float64Array.from(this.fineY.subarray(o0 - this.fineJ0, o1 - this.fineJ0 + 1))
      xs.set(tx, o0 - ja)
      ys.set(ty, o0 - ja)
      if (o0 > ja) this.evalRange(ja, o0 - 1, ja, xs, ys)
      if (o1 < jb) this.evalRange(o1 + 1, jb, ja, xs, ys)
    } else {
      this.evalRange(ja, jb, ja, xs, ys)
    }
    this.fineX = xs
    this.fineY = ys
    this.fineJ0 = ja
    this.fineN = count
  }

  /** Series at t = j * fineDt for j in [j0, j1] into xs/ys at j - base; one trig per term, then rotations. */
  private evalRange(j0: number, j1: number, base: number, xs: Float64Array, ys: Float64Array): void {
    const coeffs = this.coeffs
    if (coeffs === null) return
    const k = this.k
    const dt = this.fineDt
    if (this.fineZ.length < 2 * k) {
      this.fineZ = new Float64Array(2 * k)
      this.fineR = new Float64Array(2 * k)
    }
    const z = this.fineZ
    const r = this.fineR
    const t0 = j0 * dt
    for (let i = 0; i < k; i++) {
      const f = TAU * coeffs.freq[i]
      const a = f * t0
      const c = Math.cos(a)
      const sn = Math.sin(a)
      z[2 * i] = coeffs.re[i] * c - coeffs.im[i] * sn
      z[2 * i + 1] = coeffs.re[i] * sn + coeffs.im[i] * c
      r[2 * i] = Math.cos(f * dt)
      r[2 * i + 1] = Math.sin(f * dt)
    }
    for (let j = j0; j <= j1; j++) {
      let x = 0
      let y = 0
      for (let i = 0; i < k; i++) {
        const zr = z[2 * i]
        const zi = z[2 * i + 1]
        x += zr
        y += zi
        z[2 * i] = zr * r[2 * i] - zi * r[2 * i + 1]
        z[2 * i + 1] = zr * r[2 * i + 1] + zi * r[2 * i]
      }
      xs[j - base] = x
      ys[j - base] = y
    }
  }

  /** The cached fine trail for t in [t0, t1]; ends exactly at t0/t1 (the tip end is joined to the tip). */
  private strokeFine(view: View, t0: number, t1: number, line: string | undefined, jumps: string | undefined): void {
    if (t1 <= t0 || this.fineN === 0) return
    const dt = this.fineDt
    const ja = Math.max(this.fineJ0, Math.ceil(t0 / dt))
    const jb = Math.min(this.fineJ0 + this.fineN - 1, Math.floor(t1 / dt))
    if (jb < ja) return
    const { ox, oy, s } = view
    const linePath = new Path2D()
    const jumpPath = new Path2D()
    const n = this.trailJump.length
    const tipX = ox + this.chain[2 * this.k] * s
    const tipY = oy + this.chain[2 * this.k + 1] * s
    // The tip sits at this.t, which is one end of the range.
    const tipAtEnd = Math.abs(t1 - this.t) < Math.abs(t0 - this.t)
    let px = tipAtEnd ? Number.NaN : tipX
    let py = tipAtEnd ? Number.NaN : tipY
    const seg = (x: number, y: number, tt: number) => {
      if (!Number.isNaN(px)) {
        const idx = ((Math.floor(tt * n) % n) + n) % n
        const p = n > 0 && this.trailJump[idx] === 1 ? jumpPath : linePath
        p.moveTo(px, py)
        p.lineTo(x, y)
      }
      px = x
      py = y
    }
    for (let j = ja; j <= jb; j++) seg(ox + this.fineX[j - this.fineJ0] * s, oy + this.fineY[j - this.fineJ0] * s, (j - 0.5) * dt)
    if (tipAtEnd) seg(tipX, tipY, t1)
    this.ctx.strokeStyle = jumps ?? this.jumpColor
    this.ctx.stroke(jumpPath)
    this.ctx.strokeStyle = line ?? this.colors.trail
    this.ctx.stroke(linePath)
  }

  /** The whole closed trail from the layer, redrawing the layer first if it's stale. */
  private drawLayer(view: View, n: number): void {
    const key = `${view.ox} ${view.oy} ${view.s} ${this.ctx.lineWidth}`
    if (this.layer === null || this.layerKey !== key) {
      this.layer ??= document.createElement('canvas')
      // Setting the size clears the layer and resets its context.
      this.layer.width = this.canvas.width
      this.layer.height = this.canvas.height
      const lc = this.layer.getContext('2d')
      if (lc === null) {
        this.layer = null
        this.strokeRun(this.ctx, view, 0, n + 1, Number.NaN, Number.NaN, this.colors.trail, this.jumpColor)
        return
      }
      lc.lineCap = this.ctx.lineCap
      lc.lineJoin = this.ctx.lineJoin
      lc.lineWidth = this.ctx.lineWidth
      this.strokeRun(lc, view, 0, n + 1, Number.NaN, Number.NaN, this.colors.trail, this.jumpColor)
      this.layerKey = key
    }
    this.ctx.drawImage(this.layer, 0, 0)
  }

  /** Stroke count trail points from start: jumps first in their fainter color, then the line over them. */
  private strokeRun(
    ctx: CanvasRenderingContext2D,
    view: View,
    start: number,
    count: number,
    tipX: number,
    tipY: number,
    line: string,
    jumps: string,
  ): void {
    const { ox, oy, s } = view
    const linePath = new Path2D()
    const jumpPath = new Path2D()
    traceTrail(linePath, jumpPath, this.trailRe, this.trailIm, this.trailJump, start, count, ox, oy, s, tipX, tipY, this.clip)
    ctx.strokeStyle = jumps
    ctx.stroke(jumpPath)
    ctx.strokeStyle = line
    ctx.stroke(linePath)
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
      // A circle much bigger than the screen only shows a short arc; drawing all of it makes the
      // browser tessellate a circle tens of thousands of pixels around.
      const cx = x - w / 2
      const cy = y - h / 2
      const d = Math.hypot(cx, cy)
      const R = Math.hypot(w, h) / 2
      if (r > 2 * R && d > 0) {
        if (Math.abs(d - r) > R) continue
        const cosA = (d * d + r * r - R * R) / (2 * d * r)
        const half = Math.acos(Math.max(-1, Math.min(1, cosA)))
        const mid = Math.atan2(-cy, -cx)
        ctx.moveTo(x + r * Math.cos(mid - half), y + r * Math.sin(mid - half))
        ctx.arc(x, y, r, mid - half, mid + half)
        continue
      }
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
    const w = this.canvas.width
    const h = this.canvas.height
    // Arrows entirely off one side of the screen are skipped; zoomed in, that's most of them.
    const off = (ax: number, ay: number, bx: number, by: number) =>
      (ax < 0 && bx < 0) || (ax > w && bx > w) || (ay < 0 && by < 0) || (ay > h && by > h)
    ctx.beginPath()
    let px = ox + chain[0] * s
    let py = oy + chain[1] * s
    let pen = false
    let i = 0
    for (; i < this.k; i++) {
      if (amp[i] * s < MIN_RADIUS_PX) break
      const x = ox + chain[2 * i + 2] * s
      const y = oy + chain[2 * i + 3] * s
      if (off(px, py, x, y)) {
        pen = false
      } else {
        if (!pen) ctx.moveTo(px, py)
        ctx.lineTo(x, y)
        pen = true
      }
      px = x
      py = y
    }
    // The skipped sub-pixel arrows still add up; finish the chain at the tip.
    if (i < this.k && !off(px, py, tipSx, tipSy)) {
      if (!pen) ctx.moveTo(px, py)
      ctx.lineTo(tipSx, tipSy)
    }
    ctx.strokeStyle = this.colors.arrow
    ctx.lineWidth = (this.opts.arrowWidth ?? 1.25) * this.dpr
    ctx.stroke()
  }
}
