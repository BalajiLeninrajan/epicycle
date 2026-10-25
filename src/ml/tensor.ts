// Conversions between ImageData / GrayImage and model tensors. Pure, no ORT dependency.

import type { GrayImage } from '../pipeline/types'

export interface Rgba {
  width: number
  height: number
  data: Uint8ClampedArray
}

/**
 * Source taps for resampling n destination pixels from a span of `span` source pixels,
 * pixel-center aligned (align_corners = false). Sample positions are clamped to the span,
 * so nothing outside it (e.g. padding) bleeds in.
 */
function taps(n: number, span: number, srcLen: number): { i0: Int32Array; i1: Int32Array; w: Float32Array } {
  const i0 = new Int32Array(n)
  const i1 = new Int32Array(n)
  const w = new Float32Array(n)
  const scale = span / n
  const max = Math.max(0, Math.min(span, srcLen) - 1)
  const last = srcLen - 1
  for (let i = 0; i < n; i++) {
    let s = (i + 0.5) * scale - 0.5
    if (s < 0) s = 0
    if (s > max) s = max
    const f = Math.floor(s)
    i0[i] = f
    i1[i] = Math.min(f + 1, last)
    w[i] = s - f
  }
  return { i0, i1, w }
}

/**
 * Bilinear resize of an RGBA image into a planar float tensor [3, outH, outW] (RGB order).
 * Transparent pixels are composited over white. Each channel becomes (v / 255 - mean) / std.
 * Meant for scale factors within about 2x; larger downscales alias.
 */
export function rgbaToChw(
  image: Rgba,
  outW: number,
  outH: number,
  mean: readonly [number, number, number] = [0, 0, 0],
  std: readonly [number, number, number] = [1, 1, 1],
): Float32Array {
  const { width: w, height: h, data } = image
  const plane = outW * outH
  const out = new Float32Array(3 * plane)
  if (w === 0 || h === 0 || plane === 0) return out
  const tx = taps(outW, w, w)
  const ty = taps(outH, h, h)
  const sr = 1 / (255 * std[0])
  const sg = 1 / (255 * std[1])
  const sb = 1 / (255 * std[2])
  const or = mean[0] / std[0]
  const og = mean[1] / std[1]
  const ob = mean[2] / std[2]

  // Composite once into a float RGB buffer so the resize loop stays branch free.
  const rgb = new Float32Array(3 * w * h)
  for (let i = 0, j = 0; j < data.length; i += 3, j += 4) {
    const a = data[j + 3] / 255
    const bg = 255 * (1 - a)
    rgb[i] = data[j] * a + bg
    rgb[i + 1] = data[j + 1] * a + bg
    rgb[i + 2] = data[j + 2] * a + bg
  }

  for (let y = 0; y < outH; y++) {
    const r0 = ty.i0[y] * w
    const r1 = ty.i1[y] * w
    const wy = ty.w[y]
    const o = y * outW
    for (let x = 0; x < outW; x++) {
      const wx = tx.w[x]
      const a = 3 * (r0 + tx.i0[x])
      const b = 3 * (r0 + tx.i1[x])
      const c = 3 * (r1 + tx.i0[x])
      const d = 3 * (r1 + tx.i1[x])
      const w00 = (1 - wx) * (1 - wy)
      const w01 = wx * (1 - wy)
      const w10 = (1 - wx) * wy
      const w11 = wx * wy
      const k = o + x
      out[k] = (rgb[a] * w00 + rgb[b] * w01 + rgb[c] * w10 + rgb[d] * w11) * sr - or
      out[plane + k] = (rgb[a + 1] * w00 + rgb[b + 1] * w01 + rgb[c + 1] * w10 + rgb[d + 1] * w11) * sg - og
      out[2 * plane + k] = (rgb[a + 2] * w00 + rgb[b + 2] * w01 + rgb[c + 2] * w10 + rgb[d + 2] * w11) * sb - ob
    }
  }
  return out
}

/**
 * Bilinear resize of a single-channel plane. Only the top-left cropW x cropH region of the
 * source is used (fractional sizes allowed), which strips padding added before inference.
 */
export function resizePlane(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  cropW: number = srcW,
  cropH: number = srcH,
): Float32Array {
  const out = new Float32Array(dstW * dstH)
  if (srcW === 0 || srcH === 0 || out.length === 0) return out
  const tx = taps(dstW, Math.min(cropW, srcW), srcW)
  const ty = taps(dstH, Math.min(cropH, srcH), srcH)
  for (let y = 0; y < dstH; y++) {
    const r0 = ty.i0[y] * srcW
    const r1 = ty.i1[y] * srcW
    const wy = ty.w[y]
    const o = y * dstW
    for (let x = 0; x < dstW; x++) {
      const x0 = tx.i0[x]
      const x1 = tx.i1[x]
      const wx = tx.w[x]
      const top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * wx
      const bot = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * wx
      out[o + x] = top + (bot - top) * wy
    }
  }
  return out
}

/** Logistic sigmoid, in place. Stable for large |x|. */
export function sigmoidInPlace(a: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    if (x >= 0) {
      a[i] = 1 / (1 + Math.exp(-x))
    } else {
      const e = Math.exp(x)
      a[i] = e / (1 + e)
    }
  }
  return a
}

/** 1 - clamp(v, 0, 1), in place. Turns a white-paper drawing into ink probability. */
export function invertUnitInPlace(a: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    a[i] = v <= 0 ? 1 : v >= 1 ? 0 : 1 - v
  }
  return a
}

/**
 * Model input size for an image: scale so the long side is `longSide`, then round both
 * sides to a multiple of `multiple` (at least `multiple`).
 */
export function fitSize(width: number, height: number, longSide: number, multiple: number): { width: number; height: number } {
  const s = longSide / Math.max(width, height, 1)
  const round = (v: number) => Math.max(multiple, Math.round((v * s) / multiple) * multiple)
  return { width: round(width), height: round(height) }
}

/** Index of the largest value (first on ties). -1 for an empty array. */
export function argmax(a: ArrayLike<number>, start = 0, end = a.length): number {
  let best = -1
  let bestV = -Infinity
  for (let i = start; i < end; i++) {
    if (a[i] > bestV) {
      bestV = a[i]
      best = i
    }
  }
  return best < 0 ? -1 : best - start
}

export function grayImage(width: number, height: number, data: Float32Array = new Float32Array(width * height)): GrayImage {
  return { width, height, data }
}
