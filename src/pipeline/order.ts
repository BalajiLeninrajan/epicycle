import type { Polyline, SinglePath } from './types'

export interface OrderOptions {
  /** Max 2-opt passes. */
  maxPasses?: number
  /** Time budget for improvement in ms. */
  timeBudgetMs?: number
}

const DEFAULT_MAX_PASSES = 50
const DEFAULT_TIME_BUDGET_MS = 200
/** Neighbor list size for 2-opt and Or-opt candidates. */
const K = 8
const EPS = 1e-9
const MAX_GRID_SIDE = 2048

/** Uniform grid over a static point set. count[] shrinks when entries are swap-removed. */
interface Grid {
  minX: number
  minY: number
  inv: number
  cs: number
  gw: number
  gh: number
  start: Int32Array
  count: Int32Array
  /** Point ids grouped by cell. */
  items: Int32Array
}

function buildGrid(xs: Float64Array, ys: Float64Array, n: number, perCell: number): Grid {
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
  const w = maxX - minX
  const h = maxY - minY
  const cells = Math.max(1, Math.ceil(n / perCell))
  let cs = w * h > 0 ? Math.sqrt((w * h) / cells) : Math.max(w, h) / cells
  cs = Math.max(cs, w / (MAX_GRID_SIDE - 1), h / (MAX_GRID_SIDE - 1))
  if (!(cs > 0) || !Number.isFinite(cs)) cs = 1
  const inv = 1 / cs
  const gw = Math.min(MAX_GRID_SIDE, Math.floor(w * inv) + 1)
  const gh = Math.min(MAX_GRID_SIDE, Math.floor(h * inv) + 1)
  const g: Grid = {
    minX,
    minY,
    inv,
    cs,
    gw,
    gh,
    start: new Int32Array(gw * gh),
    count: new Int32Array(gw * gh),
    items: new Int32Array(n),
  }
  const cellOfPt = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const c = cellOf(g, xs[i], ys[i])
    cellOfPt[i] = c
    g.count[c]++
  }
  let acc = 0
  for (let c = 0; c < gw * gh; c++) {
    g.start[c] = acc
    acc += g.count[c]
    g.count[c] = 0
  }
  for (let i = 0; i < n; i++) {
    const c = cellOfPt[i]
    g.items[g.start[c] + g.count[c]++] = i
  }
  return g
}

function cellX(g: Grid, x: number): number {
  const cx = Math.floor((x - g.minX) * g.inv)
  return cx < 0 ? 0 : cx >= g.gw ? g.gw - 1 : cx
}

function cellY(g: Grid, y: number): number {
  const cy = Math.floor((y - g.minY) * g.inv)
  return cy < 0 ? 0 : cy >= g.gh ? g.gh - 1 : cy
}

function cellOf(g: Grid, x: number, y: number): number {
  return cellY(g, y) * g.gw + cellX(g, x)
}

/** Distance from q to the border of its cell. Points outside rings 0..r-1 are at least (r - 1) * cs + this away. */
function cellSlack(g: Grid, qx: number, qy: number, cx: number, cy: number): number {
  const fx = qx - g.minX - cx * g.cs
  const fy = qy - g.minY - cy * g.cs
  const s = Math.min(fx, g.cs - fx, fy, g.cs - fy)
  return s > 0 ? s : 0
}

/**
 * Nearest entry whose stroke is not visited. Visited entries met along the way are swap-removed
 * from their cell so later queries skip them. Returns -1 when nothing is left.
 */
function nearestUnvisited(
  g: Grid,
  xs: Float64Array,
  ys: Float64Array,
  owner: Int32Array,
  visited: Uint8Array,
  qx: number,
  qy: number,
): number {
  const cx = cellX(g, qx)
  const cy = cellY(g, qy)
  const maxR = Math.max(g.gw, g.gh)
  const { start, count, items, gw, gh } = g
  let best = -1
  let bestD2 = Infinity
  const slack = cellSlack(g, qx, qy, cx, cy)
  for (let r = 0; r <= maxR; r++) {
    if (best >= 0 && r > 0) {
      const lim = (r - 1) * g.cs + slack
      if (lim * lim >= bestD2) break
    }
    const y0 = cy - r
    const y1 = cy + r
    for (let y = y0 < 0 ? 0 : y0; y <= y1 && y < gh; y++) {
      const edgeRow = y === y0 || y === y1
      const xStep = edgeRow || r === 0 ? 1 : 2 * r
      for (let x = cx - r; x <= cx + r; x += xStep) {
        if (x < 0 || x >= gw) continue
        const c = y * gw + x
        const s0 = start[c]
        let n = count[c]
        let i = 0
        while (i < n) {
          const id = items[s0 + i]
          if (visited[owner[id]]) {
            items[s0 + i] = items[s0 + n - 1]
            items[s0 + n - 1] = id
            n--
            continue
          }
          const dx = xs[id] - qx
          const dy = ys[id] - qy
          const d2 = dx * dx + dy * dy
          if (d2 < bestD2) {
            bestD2 = d2
            best = id
          }
          i++
        }
        count[c] = n
      }
    }
  }
  return best
}

/** k nearest points to point q, excluding points owned by q's owner. Writes ids ascending by distance, -1 padded. */
function knn(
  g: Grid,
  xs: Float64Array,
  ys: Float64Array,
  owner: Int32Array,
  q: number,
  k: number,
  outIds: Int32Array,
  outOff: number,
  d2s: Float64Array,
): void {
  const qx = xs[q]
  const qy = ys[q]
  const skip = owner[q]
  const cx = cellX(g, qx)
  const cy = cellY(g, qy)
  const maxR = Math.max(g.gw, g.gh)
  const { start, count, items, gw, gh } = g
  let found = 0
  for (let i = 0; i < k; i++) outIds[outOff + i] = -1
  const slack = cellSlack(g, qx, qy, cx, cy)
  for (let r = 0; r <= maxR; r++) {
    if (found === k && r > 0) {
      const lim = (r - 1) * g.cs + slack
      if (lim * lim >= d2s[k - 1]) break
    }
    const y0 = cy - r
    const y1 = cy + r
    for (let y = y0 < 0 ? 0 : y0; y <= y1 && y < gh; y++) {
      const edgeRow = y === y0 || y === y1
      const xStep = edgeRow || r === 0 ? 1 : 2 * r
      for (let x = cx - r; x <= cx + r; x += xStep) {
        if (x < 0 || x >= gw) continue
        const c = y * gw + x
        const e = start[c] + count[c]
        for (let j = start[c]; j < e; j++) {
          const id = items[j]
          if (owner[id] === skip) continue
          const dx = xs[id] - qx
          const dy = ys[id] - qy
          const d2 = dx * dx + dy * dy
          if (found === k && d2 >= d2s[k - 1]) continue
          // Insertion into the sorted top-k list.
          let p = found < k ? found++ : k - 1
          while (p > 0 && d2s[p - 1] > d2) {
            d2s[p] = d2s[p - 1]
            outIds[outOff + p] = outIds[outOff + p - 1]
            p--
          }
          d2s[p] = d2
          outIds[outOff + p] = id
        }
      }
    }
  }
}

/**
 * Join strokes into one closed path that keeps jumps short.
 * Each stroke may be walked in either direction; closed strokes may be entered at any vertex.
 * Nearest-neighbor construction, then 2-opt with direction flips.
 */
export function orderStrokes(strokes: Polyline[], opts?: OrderOptions): SinglePath {
  const maxPasses = opts?.maxPasses ?? DEFAULT_MAX_PASSES
  const budget = opts?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS

  const src: Polyline[] = []
  for (const s of strokes) if (s.length >= 2) src.push(s)
  const m = src.length
  if (m === 0) return { points: new Float32Array(0), jump: new Uint8Array(0) }

  const npts = new Int32Array(m)
  const closed = new Uint8Array(m)
  let totalPts = 0
  let entCount = 0
  for (let s = 0; s < m; s++) {
    const p = src[s]
    const n = p.length >> 1
    npts[s] = n
    totalPts += n
    if (n >= 3 && p[0] === p[2 * n - 2] && p[1] === p[2 * n - 1]) {
      closed[s] = 1
      entCount += n - 1
    } else {
      entCount += 2
    }
  }

  // --- Nearest-neighbor construction ---
  // Entries: both endpoints of open strokes, every distinct vertex of closed strokes.
  const entX = new Float64Array(entCount)
  const entY = new Float64Array(entCount)
  const entOwner = new Int32Array(entCount)
  const entVert = new Int32Array(entCount)
  {
    let e = 0
    for (let s = 0; s < m; s++) {
      const p = src[s]
      const n = npts[s]
      if (closed[s]) {
        for (let v = 0; v < n - 1; v++) {
          entX[e] = p[2 * v]
          entY[e] = p[2 * v + 1]
          entOwner[e] = s
          entVert[e++] = v
        }
      } else {
        entX[e] = p[0]
        entY[e] = p[1]
        entOwner[e] = s
        entVert[e++] = 0
        entX[e] = p[2 * n - 2]
        entY[e] = p[2 * n - 1]
        entOwner[e] = s
        entVert[e++] = n - 1
      }
    }
  }

  const tour = new Int32Array(m)
  const pos = new Int32Array(m)
  /** 1 = walk the stroke backwards. */
  const dir = new Uint8Array(m)
  /** Entry (and exit) vertex of closed strokes. */
  const entry = new Int32Array(m)
  {
    const grid = buildGrid(entX, entY, entCount, 2)
    const visited = new Uint8Array(m)
    visited[0] = 1
    let curX = closed[0] ? src[0][0] : src[0][2 * npts[0] - 2]
    let curY = closed[0] ? src[0][1] : src[0][2 * npts[0] - 1]
    for (let i = 1; i < m; i++) {
      const e = nearestUnvisited(grid, entX, entY, entOwner, visited, curX, curY)
      const s = entOwner[e]
      visited[s] = 1
      tour[i] = s
      pos[s] = i
      const p = src[s]
      if (closed[s]) {
        entry[s] = entVert[e]
        curX = entX[e]
        curY = entY[e]
      } else {
        const back = entVert[e] !== 0
        dir[s] = back ? 1 : 0
        const xv = back ? 0 : npts[s] - 1
        curX = p[2 * xv]
        curY = p[2 * xv + 1]
      }
    }
  }

  // Stroke ends: a = first vertex (entry vertex for closed), b = last vertex (same as a for closed).
  // Endpoint id 2s+0 is a, 2s+1 is b.
  const epX = new Float64Array(2 * m)
  const epY = new Float64Array(2 * m)
  for (let s = 0; s < m; s++) {
    const p = src[s]
    const av = closed[s] ? entry[s] : 0
    const bv = closed[s] ? entry[s] : npts[s] - 1
    epX[2 * s] = p[2 * av]
    epY[2 * s] = p[2 * av + 1]
    epX[2 * s + 1] = p[2 * bv]
    epY[2 * s + 1] = p[2 * bv + 1]
  }

  if (m > 1 && maxPasses > 0 && budget > 0) {
    improve(m, tour, pos, dir, closed, epX, epY, maxPasses, performance.now() + budget)
    // Re-pick the entry vertex of each closed stroke for its final neighbors. Never increases cost.
    for (let i = 0; i < m; i++) {
      const s = tour[i]
      if (!closed[s]) continue
      const prev = tour[i === 0 ? m - 1 : i - 1]
      const next = tour[i === m - 1 ? 0 : i + 1]
      const pe = 2 * prev + (dir[prev] ? 0 : 1)
      const ne = 2 * next + (dir[next] ? 1 : 0)
      const px = epX[pe]
      const py = epY[pe]
      const nx = epX[ne]
      const ny = epY[ne]
      const p = src[s]
      let best = entry[s]
      let bestC = Infinity
      for (let v = 0; v < npts[s] - 1; v++) {
        const x = p[2 * v]
        const y = p[2 * v + 1]
        const c = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py)) + Math.sqrt((x - nx) * (x - nx) + (y - ny) * (y - ny))
        if (c < bestC - EPS) {
          bestC = c
          best = v
        }
      }
      entry[s] = best
      epX[2 * s] = epX[2 * s + 1] = p[2 * best]
      epY[2 * s] = epY[2 * s + 1] = p[2 * best + 1]
    }
  }

  return emit(src, tour, dir, closed, entry, npts, totalPts)
}

function emit(
  src: Polyline[],
  tour: Int32Array,
  dir: Uint8Array,
  closed: Uint8Array,
  entry: Int32Array,
  npts: Int32Array,
  totalPts: number,
): SinglePath {
  const out = new Float32Array(2 * totalPts)
  const jump = new Uint8Array(totalPts)
  let c = 0
  for (let i = 0; i < tour.length; i++) {
    const s = tour[i]
    const p = src[s]
    const n = npts[s]
    const back = dir[s] === 1
    const isClosed = closed[s] === 1
    const d = n - 1
    const v0 = entry[s]
    for (let k = 0; k < n; k++) {
      let idx: number
      if (isClosed) {
        const kk = k === d ? 0 : k
        idx = back ? (v0 - kk + d) % d : (v0 + kk) % d
      } else {
        idx = back ? n - 1 - k : k
      }
      const x = p[2 * idx]
      const y = p[2 * idx + 1]
      if (k === 0 && c > 0) {
        // Strokes that touch are joined without a jump or a duplicate point.
        if (out[2 * c - 2] === x && out[2 * c - 1] === y) continue
        jump[c - 1] = 1
      }
      out[2 * c] = x
      out[2 * c + 1] = y
      c++
    }
  }
  if (c > 0) jump[c - 1] = out[2 * c - 2] !== out[0] || out[2 * c - 1] !== out[1] ? 1 : 0
  return { points: out.slice(0, 2 * c), jump: jump.slice(0, c) }
}

/** 2-opt (including single-stroke flips) and Or-opt on the cyclic stroke sequence. Cost = total jump length. */
function improve(
  m: number,
  tour: Int32Array,
  pos: Int32Array,
  dir: Uint8Array,
  closed: Uint8Array,
  epX: Float64Array,
  epY: Float64Array,
  maxPasses: number,
  deadline: number,
): void {
  // Index endpoints; closed strokes contribute only their single entry point.
  const ids = new Int32Array(2 * m)
  let n = 0
  for (let s = 0; s < m; s++) {
    ids[n++] = 2 * s
    if (!closed[s]) ids[n++] = 2 * s + 1
  }
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const owner = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = epX[ids[i]]
    ys[i] = epY[ids[i]]
    owner[i] = ids[i] >> 1
  }
  const grid = buildGrid(xs, ys, n, 4)
  const k = Math.min(K, n - 1)
  // nbr[e * K + j]: j-th nearest endpoint id (of another stroke) to endpoint e, ascending.
  const nbr = new Int32Array(2 * m * K).fill(-1)
  const tmp = new Int32Array(K)
  const d2s = new Float64Array(K)
  for (let i = 0; i < n; i++) {
    // The neighbor lists alone can outlast the budget on clustered input (grid cells are
    // sized from the bounding box); give up on improving rather than overrun.
    if ((i & 255) === 255 && performance.now() > deadline) return
    knn(grid, xs, ys, owner, i, k, tmp, 0, d2s)
    const base = ids[i] * K
    for (let j = 0; j < k; j++) nbr[base + j] = tmp[j] < 0 ? -1 : ids[tmp[j]]
  }
  // Closed strokes share one point for both ends.
  for (let s = 0; s < m; s++) if (closed[s]) nbr.copyWithin((2 * s + 1) * K, 2 * s * K, 2 * s * K + K)

  // Endpoint ids for the entry and exit of stroke s under its current direction.
  const eId = (s: number): number => (closed[s] ? 2 * s : 2 * s + dir[s])
  const xId = (s: number): number => (closed[s] ? 2 * s : 2 * s + 1 - dir[s])
  const dist = (a: number, b: number): number => {
    const dx = epX[a] - epX[b]
    const dy = epY[a] - epY[b]
    return Math.sqrt(dx * dx + dy * dy)
  }
  const isExit = (e: number): boolean => {
    const t = e >> 1
    return closed[t] === 1 || (e & 1) !== dir[t]
  }
  const isEntry = (e: number): boolean => {
    const t = e >> 1
    return closed[t] === 1 || (e & 1) === dir[t]
  }

  /** Reverse positions a..b (cyclic) and flip each stroke's direction; reverses the shorter side. */
  const reverse = (a: number, b: number): void => {
    let len = ((b - a + m) % m) + 1
    if (2 * len > m) {
      const na = b + 1 === m ? 0 : b + 1
      b = a === 0 ? m - 1 : a - 1
      a = na
      len = m - len
    }
    for (let i = 0, j = a; i < len; i++, j = j + 1 === m ? 0 : j + 1) dir[tour[j]] ^= 1
    for (let i = 0, x = a, y = b; i < len >> 1; i++) {
      const sx = tour[x]
      const sy = tour[y]
      tour[x] = sy
      pos[sy] = x
      tour[y] = sx
      pos[sx] = y
      x = x + 1 === m ? 0 : x + 1
      y = y === 0 ? m - 1 : y - 1
    }
  }

  // Don't-look bits: a stroke is re-examined only after one of its edges changed.
  const active2 = new Uint8Array(m).fill(1)
  const activeOr = new Uint8Array(m).fill(1)
  const touch = (a: number, b: number, c: number, d: number): void => {
    active2[a] = active2[b] = active2[c] = active2[d] = 1
    activeOr[a] = activeOr[b] = activeOr[c] = activeOr[d] = 1
  }

  let timedOut = false
  let ticks = 0
  const checkTime = (): boolean => {
    if ((++ticks & 127) === 0 && performance.now() > deadline) timedOut = true
    return timedOut
  }

  /** Try 2-opt moves that remove edge p -> p+1. Applies the first improving one. */
  const tryEdge = (p: number): boolean => {
    const p1 = p + 1 === m ? 0 : p + 1
    const s1 = tour[p]
    const s2 = tour[p1]
    const P = xId(s1)
    const Q = eId(s2)
    const d1 = dist(P, Q)
    if (d1 <= EPS) return false
    // New edge X(s1) -> X(t): reverse p1..pos[t].
    for (let j = 0; j < K; j++) {
      const e = nbr[P * K + j]
      if (e < 0) break
      const dPX = dist(P, e)
      if (dPX >= d1) break
      const t = e >> 1
      if (t === s1 || !isExit(e)) continue
      const q = pos[t]
      const u = tour[q + 1 === m ? 0 : q + 1]
      const Eu = eId(u)
      if (dPX + dist(Q, Eu) - d1 - dist(e, Eu) < -EPS) {
        reverse(p1, q)
        touch(s1, s2, t, u)
        return true
      }
    }
    // New edge E(t) -> E(s2): reverse pos[t]..p.
    for (let j = 0; j < K; j++) {
      const e = nbr[Q * K + j]
      if (e < 0) break
      const dEQ = dist(Q, e)
      if (dEQ >= d1) break
      const t = e >> 1
      if (t === s2 || !isEntry(e)) continue
      const r1 = pos[t]
      const w = tour[r1 === 0 ? m - 1 : r1 - 1]
      const Xw = xId(w)
      if (dist(Xw, P) + dEQ - dist(Xw, e) - d1 < -EPS) {
        reverse(r1, p)
        touch(s1, s2, t, w)
        return true
      }
    }
    return false
  }

  const twoOptPass = (): boolean => {
    let improved = false
    for (let p = 0; p < m; p++) {
      if (checkTime()) break
      const s = tour[p]
      if (!active2[s]) continue
      // Both edges of s; positions shift after a move, so look s up again.
      if (tryEdge(p) || tryEdge(pos[s] === 0 ? m - 1 : pos[s] - 1)) improved = true
      else active2[s] = 0
    }
    return improved
  }

  const segBuf = new Int32Array(3)
  /** Move segment i..i+len-1 to sit right after stroke `after`, optionally reversed. Shifts the shorter side. */
  const moveSegment = (i: number, len: number, after: number, rev: boolean): void => {
    for (let h = 0; h < len; h++) {
      const sg = tour[(i + (rev ? len - 1 - h : h)) % m]
      if (rev) dir[sg] ^= 1
      segBuf[h] = sg
    }
    const a = pos[after]
    const fwd = ((a - i - len + 2 * m) % m) + 1
    const back = m - len - fwd
    let at: number
    if (fwd <= back) {
      for (let j = 0; j < fwd; j++) {
        const s = tour[(i + len + j) % m]
        const d = (i + j) % m
        tour[d] = s
        pos[s] = d
      }
      at = i + fwd
    } else {
      for (let j = back - 1; j >= 0; j--) {
        const s = tour[(a + 1 + j) % m]
        const d = (a + 1 + j + len) % m
        tour[d] = s
        pos[s] = d
      }
      at = a + 1
    }
    for (let h = 0; h < len; h++) {
      const d = (at + h) % m
      tour[d] = segBuf[h]
      pos[segBuf[h]] = d
    }
  }

  const orOptPass = (): boolean => {
    let improved = false
    for (let p = 0; p < m; p++) {
      if (checkTime()) return improved
      const f = tour[p]
      if (!activeOr[f]) continue
      let moved = false
      for (let len = 1; len <= 3 && len + 2 <= m && !moved; len++) {
        const i = pos[f]
        const l = tour[(i + len - 1) % m]
        const prev = tour[i === 0 ? m - 1 : i - 1]
        const next = tour[(i + len) % m]
        const Ef = eId(f)
        const Xl = xId(l)
        const Xp = xId(prev)
        const En = eId(next)
        const gain = dist(Xp, Ef) + dist(Xl, En) - dist(Xp, En)
        if (gain <= EPS) continue
        let best = -EPS
        let bestAfter = -1
        let bestNext = -1
        let bestRev = false
        for (let side = 0; side < 2; side++) {
          const from = side === 0 ? Ef : Xl
          for (let j = 0; j < K; j++) {
            const e = nbr[from * K + j]
            if (e < 0) break
            const t = e >> 1
            const pt = pos[t]
            if ((pt - i + m) % m < len) continue
            if (isExit(e) && t !== prev) {
              // Insert after t: forward when E(f) meets X(t), reversed when X(l) does.
              const jn = tour[pt + 1 === m ? 0 : pt + 1]
              const Ejn = eId(jn)
              const add =
                side === 0
                  ? dist(e, Ef) + dist(Xl, Ejn) - dist(e, Ejn)
                  : dist(e, Xl) + dist(Ef, Ejn) - dist(e, Ejn)
              if (add - gain < best) {
                best = add - gain
                bestAfter = t
                bestNext = jn
                bestRev = side === 1
              }
            }
            if (isEntry(e) && t !== next) {
              // Insert before t: reversed when E(f) meets E(t), forward when X(l) does.
              const jp = tour[pt === 0 ? m - 1 : pt - 1]
              const Xjp = xId(jp)
              const add =
                side === 0
                  ? dist(Xjp, Xl) + dist(Ef, e) - dist(Xjp, e)
                  : dist(Xjp, Ef) + dist(Xl, e) - dist(Xjp, e)
              if (add - gain < best) {
                best = add - gain
                bestAfter = jp
                bestNext = t
                bestRev = side === 0
              }
            }
          }
        }
        if (bestAfter >= 0) {
          moveSegment(i, len, bestAfter, bestRev)
          touch(prev, next, bestAfter, bestNext)
          touch(f, l, f, l)
          moved = true
        }
      }
      if (moved) improved = true
      else activeOr[f] = 0
    }
    return improved
  }

  for (let pass = 0; pass < maxPasses && !timedOut; pass++) {
    const a = twoOptPass()
    const b = !timedOut && orOptPass()
    if (!a && !b) break
  }
}
