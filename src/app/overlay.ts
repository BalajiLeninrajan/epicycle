// Overlay canvas: the mask editor (photo, outline, clicks) and the stroke preview.
import { fitScale } from '../render/camera'
import type { PipelineResult, Polyline, SamPoint } from '../pipeline/types'
import { containFit } from './logic'

export interface OverlayScene {
  /** Mask editor: photo with outline and click markers. */
  editing: boolean
  image: ImageBitmap | null
  outline: Polyline[]
  points: SamPoint[]
  /** Stroke preview, aligned with the animation's resting view. */
  strokes: Polyline[] | null
  result: PipelineResult | null
}

interface OverlayColors {
  bg: string
  stroke: string
  outline: string
  add: string
  remove: string
  ring: string
}

function colorsOf(el: Element): OverlayColors {
  const cs = getComputedStyle(el)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--fd-bg', '#1e1e2e'),
    stroke: v('--fd-stroke', '#94e2d5'),
    outline: v('--fd-outline', '#cba6f7'),
    add: v('--fd-add', '#a6e3a1'),
    remove: v('--fd-remove', '#f38ba8'),
    ring: v('--fd-ring', '#11111b'),
  }
}

/** Where the photo sits in a CSS-pixel box of the given size, for mapping clicks. */
export function imageFit(image: { width: number; height: number }, boxW: number, boxH: number) {
  return containFit(image.width, image.height, boxW, boxH)
}

/** Draw the scene. The canvas backing store is already sized to its layout box times dpr. */
export function drawOverlay(canvas: HTMLCanvasElement, scene: OverlayScene, dpr: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (w === 0 || h === 0) return
  const c = colorsOf(canvas)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (scene.editing && scene.image) {
    const img = scene.image
    const fit = imageFit(img, w, h)
    ctx.fillStyle = c.bg
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, fit.x, fit.y, img.width * fit.s, img.height * fit.s)
    // Dim the photo a little so the outline reads on any image.
    ctx.globalAlpha = 0.35
    ctx.fillRect(fit.x, fit.y, img.width * fit.s, img.height * fit.s)
    ctx.globalAlpha = 1
    // The outline comes in working-image pixels; the preview bitmap has the same size.
    strokePolylines(ctx, scene.outline, fit.x, fit.y, fit.s, 0, 0)
    ctx.strokeStyle = c.ring
    ctx.lineWidth = 4 * dpr
    ctx.stroke()
    ctx.strokeStyle = c.outline
    ctx.lineWidth = 2 * dpr
    ctx.stroke()
    const r = 6 * dpr
    for (const p of scene.points) {
      const x = fit.x + p.x * img.width * fit.s
      const y = fit.y + p.y * img.height * fit.s
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI)
      ctx.fillStyle = p.positive ? c.add : c.remove
      ctx.fill()
      ctx.strokeStyle = c.ring
      ctx.lineWidth = 2 * dpr
      ctx.stroke()
      // A bar for remove points, so the marker does not rely on color alone.
      ctx.beginPath()
      ctx.moveTo(x - r * 0.5, y)
      ctx.lineTo(x + r * 0.5, y)
      if (p.positive) {
        ctx.moveTo(x, y - r * 0.5)
        ctx.lineTo(x, y + r * 0.5)
      }
      ctx.lineWidth = 1.5 * dpr
      ctx.stroke()
    }
    return
  }

  const res = scene.result
  if (scene.strokes && res && res.sampled.scale > 0) {
    // Same mapping as the renderer at rest: pixel -> normalized -> fitScale around the center.
    const s = fitScale(w, h) / res.sampled.scale
    strokePolylines(ctx, scene.strokes, w / 2, h / 2, s, res.sampled.centerX, res.sampled.centerY)
    ctx.strokeStyle = c.stroke
    ctx.lineWidth = 1.5 * dpr
    ctx.globalAlpha = 0.85
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

/** One path for all polylines: screen = (ox + (x - cx) * s, oy + (y - cy) * s). */
function strokePolylines(
  ctx: CanvasRenderingContext2D,
  lines: Polyline[],
  ox: number,
  oy: number,
  s: number,
  cx: number,
  cy: number,
): void {
  ctx.beginPath()
  for (const pts of lines) {
    if (pts.length < 4) continue
    ctx.moveTo(ox + (pts[0] - cx) * s, oy + (pts[1] - cy) * s)
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(ox + (pts[i] - cx) * s, oy + (pts[i + 1] - cy) * s)
  }
}
