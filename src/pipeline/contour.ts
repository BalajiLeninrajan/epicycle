import type { BinaryImage, Polyline } from './types'

// Cell corners in clockwise screen order: 0 tl, 1 tr, 2 br, 3 bl. Local edge k joins
// corner k and corner k + 1: 0 top, 1 right, 2 bottom, 3 left.
// SEGMENTS[4 * case + 2j] -> SEGMENTS[4 * case + 2j + 1] are the directed segments of a
// cell, oriented so foreground is on the right on screen (outer boundaries run clockwise).
// Saddles join the foreground corners, i.e. foreground is 8-connected.
const SEGMENTS = new Int8Array(64).fill(-1)
for (let cs = 0; cs < 16; cs++) {
  let j = 0
  for (let k = 0; k < 4; k++) {
    const a = (cs >> k) & 1
    const b = (cs >> ((k + 1) & 3)) & 1
    if (!(a && !b)) continue
    for (let s = 1; s < 4; s++) {
      const e = (k + s) & 3
      if (!((cs >> e) & 1) && (cs >> ((e + 1) & 3)) & 1) {
        SEGMENTS[4 * cs + j++] = k
        SEGMENTS[4 * cs + j++] = e
        break
      }
    }
  }
}

/**
 * Outer boundaries of the foreground via marching squares. Each result is closed.
 *
 * Pixel (x, y) maps to the point (x, y), so boundary points sit halfway between a
 * foreground pixel and its background neighbor. The mask is treated as surrounded by
 * background, so blobs touching the border still close. Hole boundaries are dropped.
 * Every contour runs clockwise on screen (positive shoelace area with y pointing down).
 */
export function outerContours(mask: BinaryImage): Polyline[] {
  const { width: W, height: H, data } = mask
  const out: Polyline[] = []
  if (W === 0 || H === 0) return out

  const PW = W + 2
  const PH = H + 2
  const pad = new Uint8Array(PW * PH)
  for (let y = 0; y < H; y++) {
    const src = y * W
    const dst = (y + 1) * PW + 1
    for (let x = 0; x < W; x++) pad[dst + x] = data[src + x] ? 1 : 0
  }

  // Crossing ids: horizontal edge (px,py)-(px+1,py) is py*PW+px, vertical edge
  // (px,py)-(px,py+1) is nH + py*PW+px. next[id] is the crossing the contour visits next.
  const nH = PW * PH
  const next = new Int32Array(2 * nH).fill(-1)
  const edgeId = new Int32Array(4)
  for (let py = 0; py < PH - 1; py++) {
    for (let px = 0; px < PW - 1; px++) {
      const t = py * PW + px
      const cs = pad[t] | (pad[t + 1] << 1) | (pad[t + PW + 1] << 2) | (pad[t + PW] << 3)
      if (cs === 0 || cs === 15) continue
      edgeId[0] = t
      edgeId[1] = nH + t + 1
      edgeId[2] = t + PW
      edgeId[3] = nH + t
      const base = 4 * cs
      next[edgeId[SEGMENTS[base]]] = edgeId[SEGMENTS[base + 1]]
      if (SEGMENTS[base + 2] >= 0) next[edgeId[SEGMENTS[base + 2]]] = edgeId[SEGMENTS[base + 3]]
    }
  }

  const visited = new Uint8Array(2 * nH)
  let buf = new Float32Array(1024)
  for (let start = 0; start < 2 * nH; start++) {
    if (next[start] < 0 || visited[start]) continue
    let len = 0
    let area2 = 0
    let cur = start
    let ok = true
    do {
      visited[cur] = 1
      let x: number
      let y: number
      if (cur < nH) {
        x = (cur % PW) - 0.5
        y = ((cur / PW) | 0) - 1
      } else {
        const e = cur - nH
        x = (e % PW) - 1
        y = ((e / PW) | 0) - 0.5
      }
      if (len + 4 > buf.length) {
        const grown = new Float32Array(buf.length * 2)
        grown.set(buf)
        buf = grown
      }
      if (len >= 2) area2 += buf[len - 2] * y - x * buf[len - 1]
      buf[len++] = x
      buf[len++] = y
      cur = next[cur]
      if (cur < 0) {
        ok = false
        break
      }
    } while (cur !== start)
    if (!ok || len < 6) continue
    area2 += buf[len - 2] * buf[1] - buf[0] * buf[len - 1]
    if (area2 <= 0) continue
    buf[len++] = buf[0]
    buf[len++] = buf[1]
    out.push(buf.slice(0, len))
  }
  return out
}

/**
 * Cut the parts of contours that run along the image border. A mask that touches the
 * edge gets an outline along the frame, which isn't part of the subject's shape.
 * Contours from outerContours sit half a pixel outside the mask, so a border point has
 * x < 0, y < 0, x > width - 1 or y > height - 1. Closed contours with no border run are
 * returned unchanged; the rest are split into open polylines.
 */
export function trimImageBorder(contours: Polyline[], width: number, height: number): Polyline[] {
  const out: Polyline[] = []
  const onBorder = (x: number, y: number) => x < 0 || y < 0 || x > width - 1 || y > height - 1
  for (const c of contours) {
    const n = c.length / 2
    if (n < 2) continue
    // Segment i joins point i and i + 1; it is dropped when both ends lie on the border.
    const drop = new Uint8Array(n - 1)
    let first = -1
    for (let i = 0; i < n - 1; i++) {
      if (onBorder(c[2 * i], c[2 * i + 1]) && onBorder(c[2 * i + 2], c[2 * i + 3])) {
        drop[i] = 1
        if (first < 0) first = i
      }
    }
    if (first < 0) {
      out.push(c)
      continue
    }
    const closed = c[0] === c[2 * n - 2] && c[1] === c[2 * n - 1]
    // For a closed contour, start right after a dropped segment so no kept run wraps around.
    const segs = n - 1
    const start = closed ? first + 1 : 0
    let run: number[] = []
    const flush = () => {
      if (run.length >= 4) out.push(Float32Array.from(run))
      run = []
    }
    for (let k = 0; k < segs; k++) {
      const i = (start + k) % segs
      if (drop[i]) {
        flush()
        continue
      }
      if (run.length === 0) run.push(c[2 * i], c[2 * i + 1])
      run.push(c[2 * i + 2], c[2 * i + 3])
    }
    flush()
  }
  return out
}
