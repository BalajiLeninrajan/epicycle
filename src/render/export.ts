import { reconstruct } from '../fourier/epicycles'
import type { Coeffs, SampledPath, SinglePath } from '../pipeline/types'
import { fitScale } from './camera'
import type { EpicycleRenderer, RenderOptions } from './epicycles'
import { readThemeColors } from './theme'
import { resampleJump, trailSize, traceTrail } from './trail'

/** Export size at which opts.lineWidth is used as is; other sizes scale it. */
const PNG_REFERENCE_SIZE = 800

const WEBM_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/**
 * Render the finished drawing (full trail, no circles) to a PNG at the given size.
 * Colors come from the --fd-* custom properties on the document root.
 */
export async function exportPng(coeffs: Coeffs, sampled: SampledPath, opts: RenderOptions, size: number): Promise<Blob> {
  const px = Math.max(1, Math.round(size))
  const colors = readThemeColors(typeof document !== 'undefined' ? document.documentElement : null)

  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  let toBlob: () => Promise<Blob>
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(px, px)
    ctx = canvas.getContext('2d')
    toBlob = () => canvas.convertToBlob({ type: 'image/png' })
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = px
    canvas.height = px
    ctx = canvas.getContext('2d')
    toBlob = () =>
      new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('exportPng: encoding failed'))), 'image/png'),
      )
  }
  if (ctx === null) throw new Error('exportPng: 2D canvas context unavailable')

  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, px, px)

  const n = trailSize(sampled.re.length)
  const k = Math.max(0, Math.min(Math.floor(opts.circles), coeffs.freq.length))
  const trail = reconstruct(coeffs, k, n)
  const jump = opts.hideJumps ? resampleJump(sampled.jump, n) : null
  const s = fitScale(px, px)
  ctx.strokeStyle = colors.trail
  ctx.lineWidth = Math.max(1, (opts.lineWidth * px) / PNG_REFERENCE_SIZE)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  // n + 1 points: the last one wraps to sample 0 and closes the loop.
  traceTrail(ctx, trail.re, trail.im, jump, 0, n + 1, px / 2, px / 2, s)
  ctx.stroke()
  return toBlob()
}

/** Record one full loop of the live canvas as WebM. */
export async function recordWebm(canvas: HTMLCanvasElement, renderer: EpicycleRenderer, fps = 60): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
    throw new Error('recordWebm: MediaRecorder or canvas.captureStream is not supported')
  }
  const mimeType = WEBM_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
  const stream = canvas.captureStream(fps)
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve()
    recorder.onerror = () => {
      reject(new Error('recordWebm: recording failed'))
      // Pausing resolves playOnce early so the error surfaces instead of waiting out the loop.
      renderer.setOptions({ playing: false })
    }
  })
  stopped.catch(() => {})

  const prevTime = renderer.time
  const prevPlaying = renderer.options.playing
  try {
    renderer.setOptions({ playing: false })
    renderer.seek(0)
    recorder.start(250)
    await renderer.playOnce()
    // Give the stream a moment to pick up the final frame.
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (recorder.state !== 'inactive') recorder.stop()
    await stopped
  } finally {
    if (recorder.state !== 'inactive') recorder.stop()
    for (const track of stream.getTracks()) track.stop()
    renderer.seek(prevTime)
    renderer.setOptions({ playing: prevPlaying })
  }
  return new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' })
}

/** The single-line path as an SVG document. Jump segments are omitted when hideJumps is true. */
export function pathToSvg(path: SinglePath, width: number, height: number, hideJumps: boolean): string {
  const pts = path.points
  const jump = path.jump
  const count = pts.length >> 1
  const d: string[] = []

  if (count >= 2) {
    let pen = false
    let subStart = 0
    for (let i = 0; i < count; i++) {
      // Segment i runs from point i to point i + 1; the last one closes back to point 0.
      if (hideJumps && jump[i] === 1) {
        pen = false
        continue
      }
      if (!pen) {
        d.push(`M${fmt(pts[2 * i])} ${fmt(pts[2 * i + 1])}`)
        pen = true
        subStart = i
      }
      if (i + 1 < count) d.push(`L${fmt(pts[2 * i + 2])} ${fmt(pts[2 * i + 3])}`)
      else d.push(subStart === 0 ? 'Z' : `L${fmt(pts[0])} ${fmt(pts[1])}`)
    }
  }

  const w = fmt(width)
  const h = fmt(height)
  const body =
    d.length > 0
      ? `\n  <path d="${d.join('')}" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      : ''
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}\n</svg>\n`
  )
}

/** Rounds to 2 decimals without trailing zeros or "-0". */
function fmt(v: number): string {
  const r = Math.round(v * 100) / 100
  return r === 0 ? '0' : String(r)
}
