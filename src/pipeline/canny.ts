import { gaussianBlur } from './image'
import type { BinaryImage, GrayImage } from './types'

export interface CannyOptions {
  /** Gaussian blur sigma applied first. */
  sigma: number
  /** Hysteresis thresholds as fractions of the maximum gradient magnitude, 0..1. */
  low: number
  high: number
}

const TAN_22_5 = 0.41421356
const TAN_67_5 = 2.41421356

/** Canny edge detector: blur, Sobel, non-maximum suppression, hysteresis. 1 = edge. */
export function canny(gray: GrayImage, opts: CannyOptions): BinaryImage {
  const { width: w, height: h } = gray
  const n = w * h
  const out = new Uint8Array(n)
  if (w < 3 || h < 3) return { width: w, height: h, data: out }

  const src = gaussianBlur(gray, opts.sigma).data
  const gx = new Float32Array(n)
  const gy = new Float32Array(n)
  const mag = new Float32Array(n)
  let maxMag = 0

  // Sobel with clamp-to-edge.
  for (let y = 0; y < h; y++) {
    const rm = (y > 0 ? y - 1 : 0) * w
    const r0 = y * w
    const rp = (y < h - 1 ? y + 1 : y) * w
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0
      const xp = x < w - 1 ? x + 1 : x
      const a = src[rm + xm], b = src[rm + x], c = src[rm + xp]
      const d = src[r0 + xm], f = src[r0 + xp]
      const g = src[rp + xm], hh = src[rp + x], k = src[rp + xp]
      const sx = c + 2 * f + k - a - 2 * d - g
      const sy = g + 2 * hh + k - a - 2 * b - c
      const i = r0 + x
      gx[i] = sx
      gy[i] = sy
      const m = Math.sqrt(sx * sx + sy * sy)
      mag[i] = m
      if (m > maxMag) maxMag = m
    }
  }
  if (maxMag <= 1e-9) return { width: w, height: h, data: out }

  const lowT = Math.max(opts.low * maxMag, 1e-9)
  const highT = Math.max(opts.high * maxMag, lowT)

  // NMS into a label map: 0 none, 1 weak, 2 strong. Border pixels are skipped.
  const label = new Uint8Array(n)
  const stack = new Int32Array(n)
  let sp = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const m = mag[i]
      if (m < lowT) continue
      const ax = Math.abs(gx[i])
      const ay = Math.abs(gy[i])
      let o: number
      if (ay <= TAN_22_5 * ax) o = 1
      else if (ay >= TAN_67_5 * ax) o = w
      else o = gx[i] * gy[i] > 0 ? w + 1 : w - 1
      // Strict on one side so a two-pixel plateau keeps exactly one pixel.
      if (!(m > mag[i - o] && m >= mag[i + o])) continue
      if (m >= highT) {
        label[i] = 2
        stack[sp++] = i
      } else {
        label[i] = 1
      }
    }
  }

  // Hysteresis: grow strong edges through 8-connected weak ones.
  while (sp > 0) {
    const i = stack[--sp]
    out[i] = 1
    const y = (i / w) | 0
    const x = i - y * w
    const y0 = y > 0 ? -1 : 0
    const y1 = y < h - 1 ? 1 : 0
    const x0 = x > 0 ? -1 : 0
    const x1 = x < w - 1 ? 1 : 0
    for (let dy = y0; dy <= y1; dy++) {
      for (let dx = x0; dx <= x1; dx++) {
        const j = i + dy * w + dx
        if (label[j] === 1) {
          label[j] = 2
          stack[sp++] = j
        }
      }
    }
  }
  return { width: w, height: h, data: out }
}
