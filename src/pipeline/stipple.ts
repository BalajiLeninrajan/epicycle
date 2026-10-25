import type { BinaryImage, GrayImage, SinglePath } from './types'

export interface StippleOptions {
  count: number
  /** Lloyd relaxation iterations. */
  iterations: number
  seed?: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Writes the indices of grid cells at Chebyshev distance exactly r from (cx, cy), clipped to the grid.
 * Returns how many were written. out needs room for 8r cells (1 when r = 0).
 */
function ringCells(cx: number, cy: number, r: number, gw: number, gh: number, out: Int32Array): number {
  let n = 0
  if (r === 0) {
    if (cx >= 0 && cx < gw && cy >= 0 && cy < gh) out[n++] = cy * gw + cx
    return n
  }
  const x0 = Math.max(0, cx - r)
  const x1 = Math.min(gw - 1, cx + r)
  const top = cy - r
  const bottom = cy + r
  if (top >= 0) for (let x = x0; x <= x1; x++) out[n++] = top * gw + x
  if (bottom < gh) for (let x = x0; x <= x1; x++) out[n++] = bottom * gw + x
  const y0 = Math.max(0, top + 1)
  const y1 = Math.min(gh - 1, bottom - 1)
  const left = cx - r
  const right = cx + r
  for (let y = y0; y <= y1; y++) {
    if (left >= 0) out[n++] = y * gw + left
    if (right < gw) out[n++] = y * gw + right
  }
  return n
}

/**
 * Lloyd step state. Dots live in a uniform grid of cell size s. Density pixels are bucketed into a finer
 * grid of blocks (stored in block order for locality) with per-block weight sums, so a block that lies
 * entirely inside one Voronoi cell is assigned in O(1).
 */
interface LloydState {
  s: number
  inv: number
  gw: number
  gh: number
  bs: number
  bgw: number
  bgh: number
  halfDiag: number
  blockStart: Int32Array
  blockW: Float64Array
  blockX: Float64Array
  blockY: Float64Array
  px: Float32Array
  py: Float32Array
  pw: Float32Array
  cellStart: Int32Array
  cellDots: Int32Array
  dotCell: Int32Array
  fill: Int32Array
  ring: Int32Array
  candX: Float64Array
  candY: Float64Array
  candI: Int32Array
  candD: Float64Array
  candLB: Float64Array
}

const BLOCKS_PER_CELL = 2

function lloydState(w: number, h: number, dens: Float32Array, supIdx: Int32Array, count: number, cellSize: number): LloydState {
  const support = supIdx.length
  const s = cellSize
  const inv = 1 / s
  const gw = Math.max(1, Math.ceil(w * inv))
  const gh = Math.max(1, Math.ceil(h * inv))
  const ncell = gw * gh
  const bs = Math.max(2, s / BLOCKS_PER_CELL)
  const binv = 1 / bs
  const bgw = Math.max(1, Math.ceil(w * binv))
  const bgh = Math.max(1, Math.ceil(h * binv))
  const nblock = bgw * bgh
  const blockStart = new Int32Array(nblock + 1)
  const pixBlock = new Int32Array(support)
  for (let j = 0; j < support; j++) {
    const idx = supIdx[j]
    const y = (idx / w) | 0
    const x = idx - y * w
    const b = Math.min(bgh - 1, ((y + 0.5) * binv) | 0) * bgw + Math.min(bgw - 1, ((x + 0.5) * binv) | 0)
    pixBlock[j] = b
    blockStart[b + 1]++
  }
  for (let b = 0; b < nblock; b++) blockStart[b + 1] += blockStart[b]
  const px = new Float32Array(support)
  const py = new Float32Array(support)
  const pw = new Float32Array(support)
  const blockW = new Float64Array(nblock)
  const blockX = new Float64Array(nblock)
  const blockY = new Float64Array(nblock)
  const cursor = blockStart.slice(0, nblock)
  for (let j = 0; j < support; j++) {
    const idx = supIdx[j]
    const y = (idx / w) | 0
    const b = pixBlock[j]
    const at = cursor[b]++
    const ux = idx - y * w + 0.5
    const uy = y + 0.5
    const d = dens[idx]
    px[at] = ux
    py[at] = uy
    pw[at] = d
    blockW[b] += d
    blockX[b] += d * ux
    blockY[b] += d * uy
  }
  return {
    s,
    inv,
    gw,
    gh,
    bs,
    bgw,
    bgh,
    halfDiag: bs * Math.SQRT1_2,
    blockStart,
    blockW,
    blockX,
    blockY,
    px,
    py,
    pw,
    cellStart: new Int32Array(ncell + 1),
    cellDots: new Int32Array(count),
    dotCell: new Int32Array(count),
    fill: new Int32Array(ncell),
    ring: new Int32Array(8 * Math.max(gw, gh) + 8),
    candX: new Float64Array(count),
    candY: new Float64Array(count),
    candI: new Int32Array(count),
    candD: new Float64Array(count),
    candLB: new Float64Array(count),
  }
}

/** Assigns every density pixel to its nearest dot and accumulates weight and weighted position per dot. */
function lloydAccumulate(st: LloydState, dx: Float64Array, dy: Float64Array, sw: Float64Array, sx: Float64Array, sy: Float64Array) {
  const { s, inv, gw, gh, bs, bgw, bgh, halfDiag, blockStart, blockW, blockX, blockY } = st
  const { px, py, pw, cellStart, cellDots, dotCell, fill, ring, candX, candY, candI, candD, candLB } = st
  const count = dx.length
  const ncell = gw * gh
  const nblock = bgw * bgh
  const maxR = Math.max(gw, gh)

  cellStart.fill(0)
  for (let k = 0; k < count; k++) {
    const cx = Math.min(gw - 1, Math.max(0, (dx[k] * inv) | 0))
    const cy = Math.min(gh - 1, Math.max(0, (dy[k] * inv) | 0))
    const c = cy * gw + cx
    dotCell[k] = c
    cellStart[c + 1]++
  }
  for (let c = 0; c < ncell; c++) cellStart[c + 1] += cellStart[c]
  fill.set(cellStart.subarray(0, ncell))
  for (let k = 0; k < count; k++) cellDots[fill[dotCell[k]]++] = k

  sw.fill(0)
  sx.fill(0)
  sy.fill(0)
  for (let b = 0; b < nblock; b++) {
    const p0 = blockStart[b]
    const p1 = blockStart[b + 1]
    if (p0 === p1) continue
    const bby = (b / bgw) | 0
    const ox = (b - bby * bgw + 0.5) * bs
    const oy = (bby + 0.5) * bs
    const ccx = Math.min(gw - 1, (ox * inv) | 0)
    const ccy = Math.min(gh - 1, (oy * inv) | 0)

    // Nearest dot to the block center. Cells in ring r + 1 are at least r * s away.
    let best2 = Infinity
    for (let r = 0; r <= maxR; r++) {
      const nr = ringCells(ccx, ccy, r, gw, gh, ring)
      for (let q = 0; q < nr; q++) {
        const c = ring[q]
        for (let e = cellStart[c], e1 = cellStart[c + 1]; e < e1; e++) {
          const k = cellDots[e]
          const ex = dx[k] - ox
          const ey = dy[k] - oy
          const d2 = ex * ex + ey * ey
          if (d2 < best2) best2 = d2
        }
      }
      const lim = r * s
      if (best2 <= lim * lim) break
    }

    // Any pixel's nearest dot lies within dist(center, nearest) + 2 * halfDiag of the center.
    const R = Math.sqrt(best2) + 2 * halfDiag
    const R2 = R * R
    const cx0 = Math.max(0, ((ox - R) * inv) | 0)
    const cx1 = Math.min(gw - 1, ((ox + R) * inv) | 0)
    const cy0 = Math.max(0, ((oy - R) * inv) | 0)
    const cy1 = Math.min(gh - 1, ((oy + R) * inv) | 0)
    let nc = 0
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * gw + cx
        for (let e = cellStart[c], e1 = cellStart[c + 1]; e < e1; e++) {
          const k = cellDots[e]
          const ex = dx[k] - ox
          const ey = dy[k] - oy
          const d2 = ex * ex + ey * ey
          if (d2 > R2) continue
          // Insertion sort by distance to the block center.
          const cd = Math.sqrt(d2)
          let at = nc++
          while (at > 0 && candD[at - 1] > cd) {
            candD[at] = candD[at - 1]
            candI[at] = candI[at - 1]
            at--
          }
          candD[at] = cd
          candI[at] = k
        }
      }
    }

    // The whole block is in the first candidate's cell when every other candidate is farther from
    // every block pixel: d1 - halfDiag >= d0 + halfDiag.
    if (nc === 1 || candD[1] - candD[0] >= 2 * halfDiag) {
      const k = candI[0]
      sw[k] += blockW[b]
      sx[k] += blockX[b]
      sy[k] += blockY[b]
      continue
    }

    for (let q = 0; q < nc; q++) {
      const k = candI[q]
      candX[q] = dx[k]
      candY[q] = dy[k]
      // Lower bound on the candidate's squared distance to any pixel of the block.
      const lb = candD[q] - halfDiag
      candLB[q] = lb > 0 ? lb * lb : 0
    }

    for (let p = p0; p < p1; p++) {
      const x = px[p]
      const y = py[p]
      let bestD = Infinity
      let bestC = 0
      for (let q = 0; q < nc; q++) {
        if (candLB[q] >= bestD) break
        const ex = candX[q] - x
        const ey = candY[q] - y
        const d2 = ex * ex + ey * ey
        if (d2 < bestD) {
          bestD = d2
          bestC = q
        }
      }
      const k = candI[bestC]
      const wt = pw[p]
      sw[k] += wt
      sx[k] += wt * x
      sy[k] += wt * y
    }
  }
}

/** Weighted Voronoi stippling. Darker pixels get more dots. Returns interleaved xy in pixel space. */
export function stipple(gray: GrayImage, mask: BinaryImage | null, opts: StippleOptions): Float32Array {
  const { width: w, height: h } = gray
  if (mask && (mask.width !== w || mask.height !== h)) throw new Error('stipple: mask size does not match image')
  const npx = w * h
  const src = gray.data
  const dens = new Float32Array(npx)
  let support = 0
  let sum = 0
  let dmax = 0
  for (let i = 0; i < npx; i++) {
    let d = 1 - src[i]
    if (!(d > 0) || (mask !== null && mask.data[i] === 0)) continue
    if (d > 1) d = 1
    dens[i] = d
    support++
    sum += d
    if (d > dmax) dmax = d
  }
  // More dots than density pixels would leave dots permanently empty.
  const count = Math.min(Math.floor(opts.count), support)
  if (!(count > 0)) return new Float32Array(0)

  const supIdx = new Int32Array(support)
  for (let i = 0, j = 0; i < npx; i++) if (dens[i] > 0) supIdx[j++] = i

  const rand = mulberry32(opts.seed ?? 1)
  let cdf: Float64Array | null = null
  // Rejection sampling over the support; falls back to an inverse CDF when acceptance is poor.
  const sampleIndex = (): number => {
    for (let a = 0; a < 64; a++) {
      const idx = supIdx[(rand() * support) | 0]
      if (rand() * dmax < dens[idx]) return idx
    }
    if (cdf === null) {
      cdf = new Float64Array(support)
      let acc = 0
      for (let j = 0; j < support; j++) cdf[j] = acc += dens[supIdx[j]]
    }
    const t = rand() * cdf[support - 1]
    let lo = 0
    let hi = support - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] > t) hi = mid
      else lo = mid + 1
    }
    return supIdx[lo]
  }

  // Internal coordinates put pixel x's center at x + 0.5, so pixel x covers [x, x + 1).
  const dx = new Float64Array(count)
  const dy = new Float64Array(count)
  const placeDot = (k: number) => {
    const idx = sampleIndex()
    const y = (idx / w) | 0
    dx[k] = idx - y * w + rand()
    dy[k] = y + rand()
  }
  for (let k = 0; k < count; k++) placeDot(k)

  const iterations = Math.max(0, Math.floor(opts.iterations))
  if (iterations > 0) {
    // Cell size ~ dot spacing in the densest region, capped at 4 cells per dot overall.
    const cellSize = Math.max(Math.sqrt(sum / (count * dmax)), Math.sqrt(npx / (4 * count)), 1)
    const st = lloydState(w, h, dens, supIdx, count, cellSize)
    const sw = new Float64Array(count)
    const sx = new Float64Array(count)
    const sy = new Float64Array(count)
    for (let it = 0; it < iterations; it++) {
      lloydAccumulate(st, dx, dy, sw, sx, sy)
      for (let k = 0; k < count; k++) {
        if (sw[k] > 0) {
          dx[k] = sx[k] / sw[k]
          dy[k] = sy[k] / sw[k]
        } else {
          placeDot(k)
        }
      }
    }
  }

  const out = new Float32Array(count * 2)
  for (let k = 0; k < count; k++) {
    out[2 * k] = dx[k] - 0.5
    out[2 * k + 1] = dy[k] - 0.5
  }
  return out
}

interface PointGrid {
  minX: number
  minY: number
  s: number
  inv: number
  gw: number
  gh: number
  /** CSR: items[start[c] .. start[c + 1]) are the points in cell c. */
  start: Int32Array
  items: Int32Array
  cellOf: Int32Array
}

function buildGrid(xs: Float64Array, ys: Float64Array): PointGrid {
  const n = xs.length
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const x = xs[i]
    const y = ys[i]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const bw = maxX - minX
  const bh = maxY - minY
  // About two points per cell; the second term keeps degenerate (thin) boxes from making huge grids.
  let s = Math.max(Math.sqrt((2 * bw * bh) / n), (2 * Math.max(bw, bh)) / n)
  if (!(s > 0)) s = 1
  const inv = 1 / s
  const gw = Math.floor(bw * inv) + 1
  const gh = Math.floor(bh * inv) + 1
  const ncell = gw * gh
  const start = new Int32Array(ncell + 1)
  const cellOf = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const cx = Math.min(gw - 1, ((xs[i] - minX) * inv) | 0)
    const cy = Math.min(gh - 1, ((ys[i] - minY) * inv) | 0)
    const c = cy * gw + cx
    cellOf[i] = c
    start[c + 1]++
  }
  for (let c = 0; c < ncell; c++) start[c + 1] += start[c]
  const fill = start.slice(0, ncell)
  const items = new Int32Array(n)
  for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i
  return { minX, minY, s, inv, gw, gh, start, items, cellOf }
}

function nearestNeighborTour(xs: Float64Array, ys: Float64Array, g: PointGrid): Int32Array {
  const n = xs.length
  const { gw, gh, s, start, cellOf } = g
  const ncell = gw * gh
  // items[start[c] .. start[c] + cnt[c]) are the unvisited points of cell c.
  const items = g.items.slice()
  const cnt = new Int32Array(ncell)
  for (let c = 0; c < ncell; c++) cnt[c] = start[c + 1] - start[c]
  const slot = new Int32Array(n)
  for (let e = 0; e < n; e++) slot[items[e]] = e
  const remove = (p: number) => {
    const c = cellOf[p]
    const last = start[c] + --cnt[c]
    const q = items[last]
    const at = slot[p]
    items[at] = q
    slot[q] = at
    items[last] = p
    slot[p] = last
  }

  const ring = new Int32Array(8 * Math.max(gw, gh) + 8)
  const maxR = Math.max(gw, gh)
  const tour = new Int32Array(n)
  let cur = 0
  tour[0] = 0
  remove(0)
  for (let t = 1; t < n; t++) {
    const x = xs[cur]
    const y = ys[cur]
    const c0 = cellOf[cur]
    const cy = (c0 / gw) | 0
    const cx = c0 - cy * gw
    let best = -1
    let best2 = Infinity
    for (let r = 0; r <= maxR; r++) {
      const nc = ringCells(cx, cy, r, gw, gh, ring)
      for (let q = 0; q < nc; q++) {
        const c = ring[q]
        for (let e = start[c], e1 = start[c] + cnt[c]; e < e1; e++) {
          const k = items[e]
          const ex = xs[k] - x
          const ey = ys[k] - y
          const d2 = ex * ex + ey * ey
          if (d2 < best2) {
            best2 = d2
            best = k
          }
        }
      }
      const lim = r * s
      if (best >= 0 && best2 <= lim * lim) break
    }
    tour[t] = best
    remove(best)
    cur = best
  }
  return tour
}

/** K nearest neighbors of every point, nearest first. Row i is neigh[i * k .. i * k + k). */
function nearestNeighbors(xs: Float64Array, ys: Float64Array, g: PointGrid, k: number): Int32Array {
  const n = xs.length
  const { gw, gh, s, start, items, cellOf } = g
  const ring = new Int32Array(8 * Math.max(gw, gh) + 8)
  const maxR = Math.max(gw, gh)
  const neigh = new Int32Array(n * k)
  const bd = new Float64Array(k)
  const bi = new Int32Array(k)
  for (let i = 0; i < n; i++) {
    const x = xs[i]
    const y = ys[i]
    const cy = (cellOf[i] / gw) | 0
    const cx = cellOf[i] - cy * gw
    let found = 0
    for (let r = 0; r <= maxR; r++) {
      const nc = ringCells(cx, cy, r, gw, gh, ring)
      for (let q = 0; q < nc; q++) {
        const c = ring[q]
        for (let e = start[c], e1 = start[c + 1]; e < e1; e++) {
          const j = items[e]
          if (j === i) continue
          const ex = xs[j] - x
          const ey = ys[j] - y
          const d2 = ex * ex + ey * ey
          if (found === k && d2 >= bd[k - 1]) continue
          let at = found < k ? found++ : k - 1
          while (at > 0 && bd[at - 1] > d2) {
            bd[at] = bd[at - 1]
            bi[at] = bi[at - 1]
            at--
          }
          bd[at] = d2
          bi[at] = j
        }
      }
      const lim = r * s
      if (found === k && bd[k - 1] <= lim * lim) break
    }
    neigh.set(bi, i * k)
  }
  return neigh
}

const EPS = 1e-9

/** 2-opt with neighbor lists and a don't-look-bits queue, then Or-opt, repeated until no gain or the deadline. */
function improveTour(xs: Float64Array, ys: Float64Array, tour: Int32Array, neigh: Int32Array, k: number, deadline: number) {
  const n = tour.length
  const pos = new Int32Array(n)
  for (let i = 0; i < n; i++) pos[tour[i]] = i
  const dist = (a: number, b: number) => Math.hypot(xs[a] - xs[b], ys[a] - ys[b])

  const queue = new Int32Array(n)
  const inQ = new Uint8Array(n)
  let qHead = 0
  let qSize = 0
  const push = (c: number) => {
    if (inQ[c]) return
    inQ[c] = 1
    queue[(qHead + qSize++) % n] = c
  }
  for (let i = 0; i < n; i++) push(tour[i])

  // Reverses tour positions i..j (inclusive, wrapping). Reverses the complement when that is shorter.
  const reverse = (i: number, j: number) => {
    let len = ((j - i + n) % n) + 1
    if (2 * len > n) {
      const ni = (j + 1) % n
      j = (i - 1 + n) % n
      i = ni
      len = n - len
    }
    for (let m = 0, half = len >> 1; m < half; m++) {
      const p = (i + m) % n
      const q = (j - m + n) % n
      const a = tour[p]
      const b = tour[q]
      tour[p] = b
      pos[b] = p
      tour[q] = a
      pos[a] = q
    }
  }

  const twoOpt = (): boolean => {
    let any = false
    let steps = 0
    while (qSize > 0) {
      if ((++steps & 63) === 0 && performance.now() > deadline) return any
      const a = queue[qHead]
      qHead = (qHead + 1) % n
      qSize--
      inQ[a] = 0
      let moved = false
      for (let dir = 0; dir < 2 && !moved; dir++) {
        const ia = pos[a]
        const b = dir === 0 ? tour[(ia + 1) % n] : tour[(ia - 1 + n) % n]
        const dab = dist(a, b)
        for (let m = 0; m < k; m++) {
          const c = neigh[a * k + m]
          const dac = dist(a, c)
          if (dac >= dab) break
          const ic = pos[c]
          const d = dir === 0 ? tour[(ic + 1) % n] : tour[(ic - 1 + n) % n]
          if (c === b || d === a) continue
          if (dac + dist(b, d) - dab - dist(c, d) < -EPS) {
            if (dir === 0) reverse(pos[b], ic)
            else reverse(ia, pos[d])
            push(a)
            push(b)
            push(c)
            push(d)
            moved = true
            any = true
            break
          }
        }
      }
    }
    return any
  }

  const scratch = new Int32Array(n)
  // Moves a segment of 1-3 cities (forward from s1) between two adjacent cities elsewhere, possibly reversed.
  const orOpt = (): boolean => {
    let any = false
    for (let s1 = 0; s1 < n; s1++) {
      if (performance.now() > deadline) return any
      for (let len = 1; len <= 3 && n >= len + 3; len++) {
        const i = pos[s1]
        const s2 = tour[(i + len - 1) % n]
        const p = tour[(i - 1 + n) % n]
        const nx = tour[(i + len) % n]
        const removeGain = dist(p, s1) + dist(s2, nx) - dist(p, nx)
        if (removeGain <= EPS) continue
        let bestGain = EPS
        let bu = -1
        let rev = false
        for (let side = 0; side < 2; side++) {
          const from = side === 0 ? s1 : s2
          for (let m = 0; m < k; m++) {
            const c = neigh[from * k + m]
            if (dist(from, c) >= removeGain) break
            const ic = pos[c]
            if ((ic - i + n) % n < len) continue
            for (let e = 0; e < 2; e++) {
              const u = e === 0 ? c : tour[(ic - 1 + n) % n]
              const v = e === 0 ? tour[(ic + 1) % n] : c
              if ((pos[u] - i + n) % n < len || (pos[v] - i + n) % n < len) continue
              const duv = dist(u, v)
              const fwd = dist(u, s1) + dist(s2, v) - duv
              const bwd = dist(u, s2) + dist(s1, v) - duv
              const gain = removeGain - Math.min(fwd, bwd)
              if (gain > bestGain) {
                bestGain = gain
                bu = u
                rev = bwd < fwd
              }
            }
          }
        }
        if (bu < 0) continue
        // Rebuild: the tour without the segment, starting at nx, with the segment spliced in after bu.
        let w = 0
        for (let m = 0, at = (i + len) % n; m < n - len; m++, at = (at + 1) % n) {
          const city = tour[at]
          scratch[w++] = city
          if (city === bu) {
            for (let q = 0; q < len; q++) scratch[w++] = tour[(i + (rev ? len - 1 - q : q)) % n]
          }
        }
        tour.set(scratch)
        for (let m = 0; m < n; m++) pos[tour[m]] = m
        const v = tour[(pos[bu] + len + 1) % n]
        push(p)
        push(nx)
        push(s1)
        push(s2)
        push(bu)
        push(v)
        any = true
        break
      }
    }
    return any
  }

  while (performance.now() <= deadline) {
    twoOpt()
    if (performance.now() > deadline || !orOpt()) break
  }
}

/** TSP tour through the points (nearest-neighbor + 2-opt). No jumps flagged. */
export function tourPoints(points: Float32Array, timeBudgetMs = 1000): SinglePath {
  const n = points.length >> 1
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = points[2 * i]
    ys[i] = points[2 * i + 1]
  }
  if (n === 0) return { points: new Float32Array(0), jump: new Uint8Array(0) }
  const deadline = performance.now() + timeBudgetMs
  const grid = buildGrid(xs, ys)
  const tour = nearestNeighborTour(xs, ys, grid)
  // A budget of 0 returns the plain nearest-neighbor tour.
  if (n >= 4 && timeBudgetMs > 0) {
    const k = Math.min(10, n - 1)
    improveTour(xs, ys, tour, nearestNeighbors(xs, ys, grid, k), k, deadline)
  }
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    out[2 * i] = xs[tour[i]]
    out[2 * i + 1] = ys[tour[i]]
  }
  return { points: out, jump: new Uint8Array(n) }
}
