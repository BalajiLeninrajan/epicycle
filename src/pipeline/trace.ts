import type { BinaryImage, Polyline } from './types'

// 8 directions, clockwise on screen starting east. Even = orthogonal, odd = diagonal.
const DX = [1, 1, 0, -1, -1, -1, 0, 1]
const DY = [0, 1, 1, 1, 0, -1, -1, -1]

const POPCOUNT = new Uint8Array(256)
for (let m = 1; m < 256; m++) POPCOUNT[m] = (m & 1) + POPCOUNT[m >> 1]

const lowestBit = (m: number) => 31 - Math.clz32(m & -m)

/** Growable float buffer for building one polyline at a time. */
class PointBuffer {
  buf = new Float32Array(1024)
  len = 0

  push(x: number, y: number) {
    if (this.len + 2 > this.buf.length) {
      const grown = new Float32Array(this.buf.length * 2)
      grown.set(this.buf)
      this.buf = grown
    }
    this.buf[this.len++] = x
    this.buf[this.len++] = y
  }

  /** Push unless it equals the last point. */
  pushNew(x: number, y: number) {
    const n = this.len
    if (n >= 2 && this.buf[n - 2] === x && this.buf[n - 1] === y) return
    this.push(x, y)
  }

  take(): Polyline {
    const out = this.buf.slice(0, this.len)
    this.len = 0
    return out
  }
}

/**
 * Split a 1px skeleton into polylines at endpoints and junctions.
 * Isolated loops become closed polylines. Pixel centers are used as coordinates.
 *
 * Pixel (x, y) maps to the point (x, y). Diagonal links are ignored when a shared
 * 4-neighbor already connects the two pixels, which removes the tiny triangles at
 * staircase corners. Adjacent junction/endpoint pixels (and 2x2 blocks touching a
 * junction) are merged into one node at their centroid; every stroke touching that
 * node ends exactly at the centroid, so strokes meeting there share an endpoint.
 * Isolated pixels, and node clusters with no strokes leaving them, become 1-point polylines.
 */
export function traceSkeleton(skel: BinaryImage): Polyline[] {
  const { width: W, height: H, data } = skel
  const n = W * H
  const out: Polyline[] = []
  if (n === 0) return out

  const off = new Int32Array(8)
  for (let d = 0; d < 8; d++) off[d] = DY[d] * W + DX[d]

  // Pruned 8-neighbor adjacency as a direction bitmask per pixel.
  const adj = new Uint8Array(n)
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (!data[i]) continue
      let m = 0
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d]
        const ny = y + DY[d]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        if (!data[i + off[d]]) continue
        if (d & 1 && (data[row + nx] || data[ny * W + x])) continue
        m |= 1 << d
      }
      adj[i] = m
    }
  }

  // Node pixels: degree != 2, plus every pixel of a 2x2 block that is not an isolated 4-cycle.
  const isNode = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (data[i] && POPCOUNT[adj[i]] !== 2) isNode[i] = 1
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = y * W + x
      const b = a + 1
      const c = a + W
      const e = c + 1
      if (!(data[a] && data[b] && data[c] && data[e])) continue
      if (POPCOUNT[adj[a]] > 2 || POPCOUNT[adj[b]] > 2 || POPCOUNT[adj[c]] > 2 || POPCOUNT[adj[e]] > 2) {
        isNode[a] = isNode[b] = isNode[c] = isNode[e] = 1
      }
    }
  }

  // Merge connected node pixels into clusters.
  const cluster = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  const cx: number[] = []
  const cy: number[] = []
  for (let i = 0; i < n; i++) {
    if (!isNode[i] || cluster[i] >= 0) continue
    const id = cx.length
    let sx = 0
    let sy = 0
    let count = 0
    let sp = 0
    stack[sp++] = i
    cluster[i] = id
    while (sp > 0) {
      const p = stack[--sp]
      sx += p % W
      sy += (p / W) | 0
      count++
      let m = adj[p]
      while (m) {
        const q = p + off[lowestBit(m)]
        m &= m - 1
        if (isNode[q] && cluster[q] < 0) {
          cluster[q] = id
          stack[sp++] = q
        }
      }
    }
    cx.push(sx / count)
    cy.push(sy / count)
  }
  const exits = new Int32Array(cx.length)

  const visited = new Uint8Array(n)
  const pts = new PointBuffer()

  // Strokes leaving node clusters. Each edge is marked from both ends as it is walked.
  for (let i = 0; i < n; i++) {
    const c = cluster[i]
    if (c < 0) continue
    let m: number
    while ((m = adj[i] & ~visited[i]) !== 0) {
      const d = lowestBit(m)
      let cur = i + off[d]
      visited[i] |= 1 << d
      visited[cur] |= 1 << ((d + 4) & 7)
      if (cluster[cur] === c) continue

      exits[c]++
      pts.push(cx[c], cy[c])
      pts.pushNew(i % W, (i / W) | 0)
      while (cluster[cur] < 0) {
        pts.push(cur % W, (cur / W) | 0)
        const free = adj[cur] & ~visited[cur]
        if (!free) break
        const nd = lowestBit(free)
        visited[cur] |= 1 << nd
        cur += off[nd]
        visited[cur] |= 1 << ((nd + 4) & 7)
      }
      const ec = cluster[cur]
      if (ec >= 0) {
        exits[ec]++
        pts.push(cur % W, (cur / W) | 0)
        pts.pushNew(cx[ec], cy[ec])
      }
      out.push(pts.take())
    }
  }

  // Whatever is left are components made only of degree-2 pixels: closed loops.
  for (let i = 0; i < n; i++) {
    if (!data[i] || isNode[i] || !(adj[i] & ~visited[i])) continue
    pts.push(i % W, (i / W) | 0)
    let cur = i
    for (;;) {
      const free = adj[cur] & ~visited[cur]
      if (!free) break
      const d = lowestBit(free)
      visited[cur] |= 1 << d
      cur += off[d]
      visited[cur] |= 1 << ((d + 4) & 7)
      pts.push(cur % W, (cur / W) | 0)
      if (cur === i) break
    }
    out.push(pts.take())
  }

  for (let c = 0; c < exits.length; c++) {
    if (exits[c] === 0) out.push(new Float32Array([cx[c], cy[c]]))
  }
  return out
}

/** Squared distance from (px, py) to segment a-b. */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = ax + t * dx - px
  const ey = ay + t * dy - py
  return ex * ex + ey * ey
}

/** Mark the points of [lo, hi] that RDP keeps. lo and hi must already be marked. */
function rdpRange(poly: Polyline, lo: number, hi: number, eps2: number, keep: Uint8Array, stack: Int32Array) {
  let sp = 0
  stack[sp++] = lo
  stack[sp++] = hi
  while (sp > 0) {
    const b = stack[--sp]
    const a = stack[--sp]
    if (b - a < 2) continue
    const ax = poly[2 * a]
    const ay = poly[2 * a + 1]
    const bx = poly[2 * b]
    const by = poly[2 * b + 1]
    let best = -1
    let bestD = eps2
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(poly[2 * i], poly[2 * i + 1], ax, ay, bx, by)
      if (d > bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) continue
    keep[best] = 1
    stack[sp++] = a
    stack[sp++] = best
    stack[sp++] = best
    stack[sp++] = b
  }
}

/**
 * Ramer-Douglas-Peucker simplification. Keeps first and last points.
 * A closed polyline is split at the point farthest from its start and each half is
 * simplified separately, so it keeps at least a triangle (4 points with the repeat).
 */
export function rdp(poly: Polyline, epsilon: number): Polyline {
  const count = poly.length >> 1
  if (count <= 2) return poly
  const keep = new Uint8Array(count)
  // Each pending range pushes two ints and at most count ranges are pending.
  const stack = new Int32Array(2 * count + 4)
  const eps2 = epsilon > 0 ? epsilon * epsilon : 0
  const last = count - 1
  keep[0] = keep[last] = 1

  const closed = count >= 4 && poly[0] === poly[2 * last] && poly[1] === poly[2 * last + 1]
  if (closed) {
    const x0 = poly[0]
    const y0 = poly[1]
    let far = 1
    let farD = -1
    for (let i = 1; i < last; i++) {
      const dx = poly[2 * i] - x0
      const dy = poly[2 * i + 1] - y0
      const d = dx * dx + dy * dy
      if (d > farD) {
        farD = d
        far = i
      }
    }
    keep[far] = 1
    rdpRange(poly, 0, far, eps2, keep, stack)
    rdpRange(poly, far, last, eps2, keep, stack)

    let kept = 0
    for (let i = 0; i < count; i++) kept += keep[i]
    if (kept === 3) {
      // Loop smaller than epsilon: keep the point farthest from the start-far chord.
      const fx = poly[2 * far]
      const fy = poly[2 * far + 1]
      let best = -1
      let bestD = 0
      for (let i = 1; i < last; i++) {
        if (i === far) continue
        const d = segDist2(poly[2 * i], poly[2 * i + 1], x0, y0, fx, fy)
        if (d > bestD) {
          bestD = d
          best = i
        }
      }
      if (best >= 0) keep[best] = 1
    }
  } else {
    rdpRange(poly, 0, last, eps2, keep, stack)
  }

  let kept = 0
  for (let i = 0; i < count; i++) kept += keep[i]
  const out = new Float32Array(2 * kept)
  let j = 0
  for (let i = 0; i < count; i++) {
    if (!keep[i]) continue
    out[j++] = poly[2 * i]
    out[j++] = poly[2 * i + 1]
  }
  return out
}

export function polylineLength(poly: Polyline): number {
  let len = 0
  for (let i = 2; i + 1 < poly.length; i += 2) {
    len += Math.hypot(poly[i] - poly[i - 2], poly[i + 1] - poly[i - 1])
  }
  return len
}

/** Drop polylines shorter than minLength and simplify the rest. */
export function cleanStrokes(strokes: Polyline[], minLength: number, epsilon: number): Polyline[] {
  const out: Polyline[] = []
  for (const s of strokes) {
    if (polylineLength(s) < minLength) continue
    out.push(rdp(s, epsilon))
  }
  return out
}
