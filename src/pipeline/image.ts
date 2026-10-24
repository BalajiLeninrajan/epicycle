import type { GrayImage } from './types'

/** RGBA bytes to luminance in [0, 1]. Pixels with alpha 0 count as white. */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const n = width * height
  const data = new Float32Array(n)
  // Rec. 709 luma on the encoded values, composited over white by alpha.
  const kr = 0.2126 / 255
  const kg = 0.7152 / 255
  const kb = 0.0722 / 255
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = rgba[j + 3] / 255
    const l = kr * rgba[j] + kg * rgba[j + 1] + kb * rgba[j + 2]
    data[i] = a * l + (1 - a)
  }
  return { width, height, data }
}

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma))
  const k = new Float32Array(2 * r + 1)
  const s2 = 2 * sigma * sigma
  let sum = 0
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / s2)
    k[i + r] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return k
}

function blurRows(src: Float32Array, dst: Float32Array, w: number, h: number, k: Float32Array): void {
  const r = (k.length - 1) >> 1
  // Row copy with replicated edges so the inner loop has no bounds checks.
  const pad = new Float32Array(w + 2 * r)
  for (let y = 0; y < h; y++) {
    const off = y * w
    const first = src[off]
    const last = src[off + w - 1]
    for (let i = 0; i < r; i++) {
      pad[i] = first
      pad[r + w + i] = last
    }
    pad.set(src.subarray(off, off + w), r)
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = 0; i < k.length; i++) acc += k[i] * pad[x + i]
      dst[off + x] = acc
    }
  }
}

function blurCols(src: Float32Array, dst: Float32Array, w: number, h: number, k: Float32Array): void {
  const r = (k.length - 1) >> 1
  // Accumulate whole rows at a time to stay cache friendly.
  dst.fill(0)
  for (let y = 0; y < h; y++) {
    const off = y * w
    for (let i = 0; i < k.length; i++) {
      let sy = y + i - r
      if (sy < 0) sy = 0
      else if (sy >= h) sy = h - 1
      const kv = k[i]
      const soff = sy * w
      for (let x = 0; x < w; x++) dst[off + x] += kv * src[soff + x]
    }
  }
}

/** Separable blur with independent sigmas per axis. */
function blurXY(img: GrayImage, sx: number, sy: number): GrayImage {
  const { width: w, height: h } = img
  let cur = img.data
  if (w > 0 && h > 0 && sx > 0) {
    const out = new Float32Array(w * h)
    blurRows(cur, out, w, h, gaussianKernel(sx))
    cur = out
  }
  if (w > 0 && h > 0 && sy > 0) {
    const out = new Float32Array(w * h)
    blurCols(cur, out, w, h, gaussianKernel(sy))
    cur = out
  }
  return { width: w, height: h, data: cur === img.data ? img.data.slice() : cur }
}

/** Separable Gaussian blur. sigma in pixels; sigma <= 0 returns a copy. */
export function gaussianBlur(img: GrayImage, sigma: number): GrayImage {
  return blurXY(img, sigma, sigma)
}

/** Prefilter sigma for shrinking by `scale` (> 1), so the result does not alias. */
function antialiasSigma(scale: number): number {
  return scale > 1 ? 0.5 * Math.sqrt(scale * scale - 1) : 0
}

/** Bilinear resize. */
export function resizeGray(img: GrayImage, width: number, height: number): GrayImage {
  width = Math.max(0, Math.round(width))
  height = Math.max(0, Math.round(height))
  const out = new Float32Array(width * height)
  const { width: sw, height: sh } = img
  if (width === 0 || height === 0 || sw === 0 || sh === 0) return { width, height, data: out }
  if (width === sw && height === sh) return { width, height, data: img.data.slice() }

  const scaleX = sw / width
  const scaleY = sh / height
  const src = blurXY(img, antialiasSigma(scaleX), antialiasSigma(scaleY)).data

  // Pixel-center mapping, precomputed per column.
  const x0 = new Int32Array(width)
  const x1 = new Int32Array(width)
  const fx = new Float32Array(width)
  for (let x = 0; x < width; x++) {
    let s = (x + 0.5) * scaleX - 0.5
    if (s < 0) s = 0
    else if (s > sw - 1) s = sw - 1
    const i = Math.floor(s)
    x0[x] = i
    x1[x] = i + 1 < sw ? i + 1 : i
    fx[x] = s - i
  }
  for (let y = 0; y < height; y++) {
    let s = (y + 0.5) * scaleY - 0.5
    if (s < 0) s = 0
    else if (s > sh - 1) s = sh - 1
    const j = Math.floor(s)
    const fy = s - j
    const r0 = j * sw
    const r1 = (j + 1 < sh ? j + 1 : j) * sw
    const off = y * width
    for (let x = 0; x < width; x++) {
      const a = x0[x]
      const b = x1[x]
      const t = fx[x]
      const top = src[r0 + a] + (src[r0 + b] - src[r0 + a]) * t
      const bot = src[r1 + a] + (src[r1 + b] - src[r1 + a]) * t
      out[off + x] = top + (bot - top) * fy
    }
  }
  return { width, height, data: out }
}
