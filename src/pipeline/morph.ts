import type { BinaryImage, GrayImage } from './types'

/** 1 where gray >= t (or gray < t when invert is true). */
export function threshold(gray: GrayImage, t: number, invert?: boolean): BinaryImage {
  const src = gray.data
  const data = new Uint8Array(src.length)
  if (invert) for (let i = 0; i < src.length; i++) data[i] = src[i] < t ? 1 : 0
  else for (let i = 0; i < src.length; i++) data[i] = src[i] >= t ? 1 : 0
  return { width: gray.width, height: gray.height, data }
}

/**
 * 1 where the Euclidean distance to the nearest pixel equal to `target` is <= r.
 * Exact squared EDT (column sweep + Felzenszwalb lower envelope per row), O(n) for any r.
 * Pixels outside the image never count as targets.
 */
function withinRadius(src: Uint8Array, w: number, h: number, target: number, r: number): Uint8Array {
  const n = w * h
  const out = new Uint8Array(n)
  if (n === 0) return out
  const r2 = r * r
  // Column distances, capped: anything beyond r can never be within r.
  const cap = Math.floor(r) + 1
  const g = new Int32Array(n)
  for (let x = 0; x < w; x++) g[x] = src[x] === target ? 0 : cap
  for (let y = 1; y < h; y++) {
    const off = y * w
    for (let x = 0; x < w; x++) {
      const i = off + x
      if (src[i] === target) g[i] = 0
      else {
        const d = g[i - w] + 1
        g[i] = d < cap ? d : cap
      }
    }
  }
  for (let y = h - 2; y >= 0; y--) {
    const off = y * w
    for (let x = 0; x < w; x++) {
      const d = g[off + x + w] + 1
      if (d < g[off + x]) g[off + x] = d
    }
  }

  const v = new Int32Array(w)
  const z = new Float64Array(w + 1)
  const f = new Float64Array(w)
  for (let y = 0; y < h; y++) {
    const off = y * w
    // Only sites with a column hit within r become parabolas.
    let k = -1
    for (let q = 0; q < w; q++) {
      const gq = g[off + q]
      if (gq >= cap) continue
      const fq = gq * gq
      f[q] = fq
      if (k < 0) {
        k = 0
        v[0] = q
        z[0] = -Infinity
        z[1] = Infinity
        continue
      }
      // z[0] = -Infinity stops the pop loop at k = 0.
      let p = v[k]
      let s = (fq + q * q - (f[p] + p * p)) / (2 * (q - p))
      while (s <= z[k]) {
        k--
        p = v[k]
        s = (fq + q * q - (f[p] + p * p)) / (2 * (q - p))
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = Infinity
    }
    if (k < 0) continue
    let j = 0
    for (let q = 0; q < w; q++) {
      while (z[j + 1] < q) j++
      const p = v[j]
      const dq = q - p
      if (dq * dq + f[p] <= r2) out[off + q] = 1
    }
  }
  return out
}

/** Dilation with a disk of radius r. */
export function dilate(bin: BinaryImage, r: number): BinaryImage {
  const { width: w, height: h } = bin
  if (!(r >= 1)) return { width: w, height: h, data: bin.data.slice() }
  return { width: w, height: h, data: withinRadius(bin.data, w, h, 1, r) }
}

/** Erosion with a disk of radius r. */
export function erode(bin: BinaryImage, r: number): BinaryImage {
  const { width: w, height: h } = bin
  if (!(r >= 1)) return { width: w, height: h, data: bin.data.slice() }
  // Dual of dilation: pixels outside the image act as foreground, so the border does not erode.
  const nearBg = withinRadius(bin.data, w, h, 0, r)
  for (let i = 0; i < nearBg.length; i++) nearBg[i] ^= 1
  return { width: w, height: h, data: nearBg }
}

/** Morphological close (dilate then erode). */
export function close(bin: BinaryImage, r: number): BinaryImage {
  return erode(dilate(bin, r), r)
}

/** Remove 8-connected foreground components smaller than minArea pixels. */
export function removeSmallComponents(bin: BinaryImage, minArea: number): BinaryImage {
  const { width: w, height: h } = bin
  const src = bin.data
  const out = src.slice()
  if (minArea <= 1) return { width: w, height: h, data: out }
  const n = w * h
  const seen = new Uint8Array(n)
  // BFS queue; each component occupies a contiguous slice of it.
  const queue = new Int32Array(n)
  let tail = 0
  for (let s = 0; s < n; s++) {
    if (src[s] === 0 || seen[s]) continue
    const start = tail
    let head = tail
    queue[tail++] = s
    seen[s] = 1
    while (head < tail) {
      const i = queue[head++]
      const y = (i / w) | 0
      const x = i - y * w
      const y0 = y > 0 ? -1 : 0
      const y1 = y < h - 1 ? 1 : 0
      const x0 = x > 0 ? -1 : 0
      const x1 = x < w - 1 ? 1 : 0
      for (let dy = y0; dy <= y1; dy++) {
        for (let dx = x0; dx <= x1; dx++) {
          const j = i + dy * w + dx
          if (src[j] !== 0 && !seen[j]) {
            seen[j] = 1
            queue[tail++] = j
          }
        }
      }
    }
    if (tail - start < minArea) for (let q = start; q < tail; q++) out[queue[q]] = 0
  }
  return { width: w, height: h, data: out }
}

/** Fill background regions not connected to the image border. */
export function fillHoles(bin: BinaryImage): BinaryImage {
  const { width: w, height: h } = bin
  const src = bin.data
  const n = w * h
  // Background is 4-connected (dual of 8-connected foreground).
  const outside = new Uint8Array(n)
  const stack = new Int32Array(n)
  let sp = 0
  const seed = (i: number) => {
    if (src[i] === 0 && !outside[i]) {
      outside[i] = 1
      stack[sp++] = i
    }
  }
  for (let x = 0; x < w; x++) {
    seed(x)
    seed((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    seed(y * w)
    seed(y * w + w - 1)
  }
  while (sp > 0) {
    const i = stack[--sp]
    const y = (i / w) | 0
    const x = i - y * w
    if (x > 0 && src[i - 1] === 0 && !outside[i - 1]) { outside[i - 1] = 1; stack[sp++] = i - 1 }
    if (x < w - 1 && src[i + 1] === 0 && !outside[i + 1]) { outside[i + 1] = 1; stack[sp++] = i + 1 }
    if (y > 0 && src[i - w] === 0 && !outside[i - w]) { outside[i - w] = 1; stack[sp++] = i - w }
    if (y < h - 1 && src[i + w] === 0 && !outside[i + w]) { outside[i + w] = 1; stack[sp++] = i + w }
  }
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = outside[i] ? 0 : 1
  return { width: w, height: h, data: out }
}

/** Pixelwise AND. Sizes must match. */
export function and(a: BinaryImage, b: BinaryImage): BinaryImage {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`and: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const n = a.data.length
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = a.data[i] & b.data[i]
  return { width: a.width, height: a.height, data: out }
}
