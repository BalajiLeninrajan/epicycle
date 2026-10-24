import type { Polyline } from './types'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Target sample spacing in root user units. */
const SPACING = 1
/** Total sample budget; spacing grows past SPACING when the drawing is longer. */
const MAX_POINTS = 100_000

/** Parameters per path command, lowercase key. */
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y

export interface PathSegment {
  /** Command letter as written; case marks relative (lowercase) vs absolute. */
  cmd: string
  args: number[]
}

/**
 * Tokenize SVG path data into one segment per command instance, expanding repeated
 * parameter groups (implicit pairs after M/m become L/l). Stops at the first error,
 * like browsers render a path up to the error.
 */
export function parsePathData(d: string): PathSegment[] {
  const out: PathSegment[] = []
  const n = d.length
  let i = 0
  let cmd = ''
  const skip = () => {
    while (i < n) {
      const c = d.charCodeAt(i)
      // space, tab, CR, LF, FF, comma
      if (c === 32 || c === 9 || c === 13 || c === 10 || c === 12 || c === 44) i++
      else break
    }
  }
  for (;;) {
    skip()
    if (i >= n) break
    const ch = d[i]
    const lower = ch.toLowerCase()
    if (lower in ARITY) {
      cmd = ch
      i++
      if (lower === 'z') {
        out.push({ cmd, args: [] })
        continue
      }
    } else if (!cmd || cmd === 'z' || cmd === 'Z') {
      break
    }
    const lc = cmd.toLowerCase()
    const arity = ARITY[lc]
    const args: number[] = []
    for (let k = 0; k < arity; k++) {
      skip()
      if (lc === 'a' && (k === 3 || k === 4)) {
        const f = d[i]
        if (f !== '0' && f !== '1') return out
        args.push(f === '1' ? 1 : 0)
        i++
        continue
      }
      NUMBER.lastIndex = i
      const m = NUMBER.exec(d)
      if (!m) return out
      args.push(Number(m[0]))
      i = NUMBER.lastIndex
    }
    out.push({ cmd, args })
    // Extra pairs after a moveto are linetos.
    if (cmd === 'm') cmd = 'l'
    else if (cmd === 'M') cmd = 'L'
  }
  return out
}

/**
 * Split path data at every moveto into standalone path strings, each starting with an
 * absolute M at the subpath's true start point. Subpaths that only move are dropped.
 */
export function splitSubpaths(d: string): string[] {
  const out: string[] = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let cur: string[] | null = null
  const flush = () => {
    if (cur && cur.length > 1) out.push(cur.join(' '))
    cur = null
  }
  for (const { cmd, args } of parsePathData(d)) {
    const rel = cmd >= 'a'
    switch (cmd.toUpperCase()) {
      case 'M':
        cx = rel ? cx + args[0] : args[0]
        cy = rel ? cy + args[1] : args[1]
        sx = cx
        sy = cy
        flush()
        cur = [`M${cx} ${cy}`]
        continue
      case 'Z':
        if (cur) cur.push('Z')
        cx = sx
        cy = sy
        continue
    }
    // A drawing command with no preceding moveto starts at the current point.
    if (!cur) cur = [`M${cx} ${cy}`]
    cur.push(cmd + args.join(' '))
    switch (cmd.toUpperCase()) {
      case 'H':
        cx = rel ? cx + args[0] : args[0]
        break
      case 'V':
        cy = rel ? cy + args[0] : args[0]
        break
      default: {
        const x = args[args.length - 2]
        const y = args[args.length - 1]
        cx = rel ? cx + x : x
        cy = rel ? cy + y : y
      }
    }
  }
  flush()
  return out
}

/** Parse a viewBox attribute. null when missing or degenerate. */
export function parseViewBox(attr: string | null): { x: number; y: number; width: number; height: number } | null {
  if (!attr) return null
  const v = attr.trim().split(/[\s,]+/).map(Number)
  if (v.length !== 4 || !v.every(Number.isFinite) || v[2] <= 0 || v[3] <= 0) return null
  return { x: v[0], y: v[1], width: v[2], height: v[3] }
}

/** Absolute length attribute in user units; null for percentages or unparseable values. */
function absLength(attr: string | null): number | null {
  if (!attr) return null
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px)?\s*$/.exec(attr)
  if (!m) return null
  const v = Number(m[1])
  return v > 0 ? v : null
}

// Only geometry and grouping survive the copy into the live document, with geometry
// attributes only. Scripts, event handlers, external references and styles never load.
const COMMON = ['transform', 'display', 'visibility']
const ALLOWED: Record<string, string[]> = {
  svg: ['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio', ...COMMON],
  g: COMMON,
  a: COMMON,
  switch: COMMON,
  path: ['d', ...COMMON],
  line: ['x1', 'y1', 'x2', 'y2', ...COMMON],
  polyline: ['points', ...COMMON],
  polygon: ['points', ...COMMON],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', ...COMMON],
  circle: ['cx', 'cy', 'r', ...COMMON],
  ellipse: ['cx', 'cy', 'rx', 'ry', ...COMMON],
}
const CONTAINERS = new Set(['svg', 'g', 'a', 'switch'])

function copySafe(src: Element, shapes: SVGGeometryElement[]): SVGElement | null {
  const tag = src.localName
  const allowed = ALLOWED[tag]
  if (!allowed || src.namespaceURI !== SVG_NS) return null
  const el = document.createElementNS(SVG_NS, tag) as SVGElement
  for (const name of allowed) {
    const v = src.getAttribute(name)
    if (v !== null) el.setAttribute(name, v)
  }
  if (CONTAINERS.has(tag)) {
    for (const child of src.children) {
      const c = copySafe(child, shapes)
      if (c) el.appendChild(c)
    }
    return el
  }
  if (tag === 'path') {
    // One path element per subpath, so each is sampled on its own and the jump between them is not drawn.
    const parts = splitSubpaths(src.getAttribute('d') ?? '')
    if (parts.length === 0) return null
    if (parts.length === 1) {
      el.setAttribute('d', parts[0])
      shapes.push(el as SVGGeometryElement)
      return el
    }
    const g = document.createElementNS(SVG_NS, 'g')
    for (const name of COMMON) {
      const v = src.getAttribute(name)
      if (v !== null) g.setAttribute(name, v)
    }
    for (const d of parts) {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('d', d)
      g.appendChild(p)
      shapes.push(p)
    }
    return g
  }
  shapes.push(el as SVGGeometryElement)
  return el
}

interface Piece {
  el: SVGGeometryElement
  m: DOMMatrix
  len: number
  /** Root units per local unit. */
  scale: number
}

/** Parse an SVG document (main thread only, needs the DOM) and sample its shapes into polylines. */
export function svgToStrokes(svgText: string): { strokes: Polyline[]; width: number; height: number } {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const src = doc.documentElement
  if (doc.getElementsByTagName('parsererror').length > 0 || src.localName !== 'svg') {
    throw new Error('Could not parse the SVG file')
  }

  const shapes: SVGGeometryElement[] = []
  const root = copySafe(src, shapes) as SVGSVGElement | null
  if (!root) throw new Error('Not an SVG document (missing the SVG namespace?)')
  const vb = parseViewBox(src.getAttribute('viewBox'))
  const attrW = absLength(src.getAttribute('width'))
  const attrH = absLength(src.getAttribute('height'))
  // A concrete viewport size keeps the root CTM invertible inside the zero-size container.
  root.setAttribute('width', String(vb?.width ?? attrW ?? 1000))
  root.setAttribute('height', String(vb?.height ?? attrH ?? 1000))

  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none'
  host.appendChild(root)
  document.body.appendChild(host)

  try {
    const rootCtm = root.getScreenCTM()
    if (!rootCtm) return { strokes: [], width: vb?.width ?? attrW ?? 0, height: vb?.height ?? attrH ?? 0 }
    // Maps screen space back to the root's user space (viewBox units).
    const rootInv = rootCtm.inverse()

    const pieces: Piece[] = []
    let total = 0
    for (const el of shapes) {
      const ctm = el.getScreenCTM()
      if (!ctm) continue
      let len: number
      try {
        len = el.getTotalLength()
      } catch {
        continue
      }
      if (!(len > 0) || !Number.isFinite(len)) continue
      const m = rootInv.multiply(ctm)
      const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
      if (!(scale > 0)) continue
      pieces.push({ el, m, len, scale })
      total += len * scale
    }

    const spacing = Math.max(SPACING, total / MAX_POINTS)
    const ox = vb?.x ?? 0
    const oy = vb?.y ?? 0
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const strokes: Polyline[] = []
    for (const { el, m, len, scale } of pieces) {
      const steps = Math.max(1, Math.ceil((len * scale) / spacing))
      const pts = new Float32Array(2 * (steps + 1))
      for (let i = 0; i <= steps; i++) {
        const p = el.getPointAtLength((len * i) / steps)
        const x = m.a * p.x + m.c * p.y + m.e - ox
        const y = m.b * p.x + m.d * p.y + m.f - oy
        pts[2 * i] = x
        pts[2 * i + 1] = y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      // Closed shapes end where they start; make the repeat exact.
      const k = 2 * steps
      if (Math.hypot(pts[k] - pts[0], pts[k + 1] - pts[1]) < spacing * 1e-3) {
        pts[k] = pts[0]
        pts[k + 1] = pts[1]
      }
      strokes.push(pts)
    }

    if (vb) return { strokes, width: vb.width, height: vb.height }
    if (attrW && attrH) return { strokes, width: attrW, height: attrH }
    if (strokes.length === 0) return { strokes, width: 0, height: 0 }
    // No declared size: crop to the drawing's bounding box.
    for (const s of strokes) {
      for (let i = 0; i < s.length; i += 2) {
        s[i] -= minX
        s[i + 1] -= minY
      }
    }
    return { strokes, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
  } finally {
    host.remove()
  }
}
