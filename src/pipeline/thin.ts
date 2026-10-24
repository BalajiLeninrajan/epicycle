import type { BinaryImage } from './types'

// Works on a copy padded by one background pixel so neighbor reads need no bounds checks.
// Neighbor names follow Zhang-Suen: p2 = N, then clockwise p3 = NE ... p9 = NW.

/** Number of 0 -> 1 transitions around the 8-ring p2..p9,p2. */
function transitions(img: Uint8Array, i: number, W: number): number {
  const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1]
  const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1]
  return (
    ((p2 ^ 1) & p3) + ((p3 ^ 1) & p4) + ((p4 ^ 1) & p5) + ((p5 ^ 1) & p6) +
    ((p6 ^ 1) & p7) + ((p7 ^ 1) & p8) + ((p8 ^ 1) & p9) + ((p9 ^ 1) & p2)
  )
}

function neighbors(img: Uint8Array, i: number, W: number): number {
  return (
    img[i - W] + img[i - W + 1] + img[i + 1] + img[i + W + 1] +
    img[i + W] + img[i + W - 1] + img[i - 1] + img[i - W - 1]
  )
}

/** Yokoi 8-connectivity number. 1 means removing the pixel keeps (8,4) topology. */
function yokoi8(img: Uint8Array, i: number, W: number): number {
  // Complemented ring starting East, counter-clockwise: E, NE, N, NW, W, SW, S, SE.
  const e = img[i + 1] ^ 1, ne = img[i - W + 1] ^ 1, nn = img[i - W] ^ 1, nw = img[i - W - 1] ^ 1
  const ww = img[i - 1] ^ 1, sw = img[i + W - 1] ^ 1, ss = img[i + W] ^ 1, se = img[i + W + 1] ^ 1
  return (
    e - e * ne * nn +
    nn - nn * nw * ww +
    ww - ww * sw * ss +
    ss - ss * se * e
  )
}

/** Drop entries of list whose pixel is now 0. Returns the new length. */
function compact(img: Uint8Array, list: Int32Array, count: number): number {
  let m = 0
  for (let k = 0; k < count; k++) {
    const p = list[k]
    if (img[p]) list[m++] = p
  }
  return m
}

/**
 * Zhang-Suen thinning to a 1px-wide 8-connected skeleton.
 * Uses the Lu-Wang neighbor bound, sequential re-checks and a staircase cleanup
 * pass, so it never removes a component or splits one.
 */
export function zhangSuen(bin: BinaryImage): BinaryImage {
  const { width: w, height: h } = bin
  const W = w + 2
  const img = new Uint8Array(W * (h + 2))
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bin.data[y * w + x]) {
        img[(y + 1) * W + x + 1] = 1
        count++
      }
    }
  }
  const list = new Int32Array(count)
  count = 0
  for (let i = 0; i < img.length; i++) if (img[i]) list[count++] = i
  const marked = new Int32Array(count)

  let changed = true
  while (changed) {
    changed = false
    for (let pass = 0; pass < 2; pass++) {
      let nm = 0
      for (let k = 0; k < count; k++) {
        const i = list[k]
        const b = neighbors(img, i, W)
        // Lu-Wang lower bound of 3 (not 2): B = 2 pixels are tips of 2px-thick
        // diagonals, and deleting them eats those lines away one pixel per pass.
        if (b < 3 || b > 6) continue
        if (transitions(img, i, W) !== 1) continue
        const p2 = img[i - W], p4 = img[i + 1], p6 = img[i + W], p8 = img[i - 1]
        if (pass === 0) {
          if (p2 & p4 & p6 || p4 & p6 & p8) continue
        } else if (p2 & p4 & p8 || p2 & p6 & p8) continue
        marked[nm++] = i
      }
      // Classic Zhang-Suen deletes all marks in parallel, which erases 2x2 squares
      // and can break 2px-thick strokes. Re-checking each mark against the current
      // image keeps every deletion topology preserving.
      let deleted = 0
      for (let k = 0; k < nm; k++) {
        const i = marked[k]
        if (neighbors(img, i, W) >= 2 && transitions(img, i, W) === 1) {
          img[i] = 0
          deleted++
        }
      }
      if (deleted > 0) {
        changed = true
        count = compact(img, list, count)
      }
    }
  }

  // Zhang-Suen leaves 4-connected staircase corners. Remove the ones that are
  // simple so the skeleton is 8-connected and 1px wide.
  changed = true
  while (changed) {
    changed = false
    for (let k = 0; k < count; k++) {
      const i = list[k]
      if (!img[i]) continue
      const n = img[i - W], e = img[i + 1], so = img[i + W], ww = img[i - 1]
      // Only staircase corners: removing other simple pixels would eat 2px lines from their tips.
      if (!((n & e) | (e & so) | (so & ww) | (ww & n))) continue
      if (neighbors(img, i, W) >= 2 && yokoi8(img, i, W) === 1) {
        img[i] = 0
        changed = true
      }
    }
    if (changed) count = compact(img, list, count)
  }

  const out = new Uint8Array(w * h)
  for (let k = 0; k < count; k++) {
    const i = list[k]
    const y = ((i / W) | 0) - 1
    const x = (i % W) - 1
    out[y * w + x] = 1
  }
  return { width: w, height: h, data: out }
}
