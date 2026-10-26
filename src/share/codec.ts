// A shared drawing is the single-line path plus the animation settings, never the picture.
// The binary layout below is deflated and sent either as a short-link body or base64url in
// the URL fragment. All integers are little-endian.
//
//   u8  magic 0x45 ('E')       u8  version (1)
//   f32 width                  f32 height
//   u16 circles                u16 duration * 10 (seconds)
//   u8  flags: 1 full trail, 2 circles, 4 arrows, 8 formula, 16 follow tip
//   u8  line width * 4         u16 follow zoom * 10
//   u8  log2(sample count)
//   varint point count, then per point zigzag varint dx, dy on a 4095-step grid over max(width, height)
//   varint jump count, then varint gaps between jump segment indices
import type { SinglePath } from '../pipeline/types'

export interface SharedDrawing {
  width: number
  height: number
  path: SinglePath
  sampleCount: 2048 | 4096 | 8192
  circles: number
  durationSec: number
  trailMode: 'full' | 'fade'
  showCircles: boolean
  showArrows: boolean
  showFormula: boolean
  followTip: boolean
  followZoom: number
  lineWidth: number
}

const MAGIC = 0x45
const VERSION = 1
const GRID = 4095
const HEADER_BYTES = 20
/** Far above any real drawing (stipple tops out around 20k); bounds decoding work and memory. */
export const MAX_POINTS = 200_000
/** Largest encoded share accepted, compressed. */
export const MAX_SHARE_BYTES = 256 * 1024

class Writer {
  private buf = new Uint8Array(4096)
  private view = new DataView(this.buf.buffer)
  length = 0

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n))
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
    this.view = new DataView(next.buffer)
  }
  u8(v: number): void {
    this.ensure(1)
    this.buf[this.length++] = v
  }
  u16(v: number): void {
    this.ensure(2)
    this.view.setUint16(this.length, v, true)
    this.length += 2
  }
  f32(v: number): void {
    this.ensure(4)
    this.view.setFloat32(this.length, v, true)
    this.length += 4
  }
  varint(v: number): void {
    this.ensure(5)
    while (v > 0x7f) {
      this.buf[this.length++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    this.buf[this.length++] = v
  }
  zigzag(v: number): void {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1)
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}

class Reader {
  private readonly view: DataView
  pos = 0
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('The shared drawing is cut short')
  }
  u8(): number {
    this.need(1)
    return this.buf[this.pos++]
  }
  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }
  f32(): number {
    this.need(4)
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }
  varint(): number {
    let v = 0
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.u8()
      v += (b & 0x7f) * 2 ** shift
      if (b < 0x80) return v
    }
    throw new Error('The shared drawing has a malformed number')
  }
  zigzag(): number {
    const v = this.varint()
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The uncompressed binary form. */
export function packDrawing(d: SharedDrawing): Uint8Array {
  const w = new Writer()
  w.u8(MAGIC)
  w.u8(VERSION)
  w.f32(d.width)
  w.f32(d.height)
  w.u16(clamp(Math.round(d.circles), 0, 0xffff))
  w.u16(clamp(Math.round(d.durationSec * 10), 1, 0xffff))
  w.u8(
    (d.trailMode === 'full' ? 1 : 0) |
      (d.showCircles ? 2 : 0) |
      (d.showArrows ? 4 : 0) |
      (d.showFormula ? 8 : 0) |
      (d.followTip ? 16 : 0),
  )
  w.u8(clamp(Math.round(d.lineWidth * 4), 1, 0xff))
  w.u16(clamp(Math.round(d.followZoom * 10), 1, 0xffff))
  w.u8(Math.round(Math.log2(d.sampleCount)))

  const pts = d.path.points
  const count = Math.min(pts.length >> 1, MAX_POINTS)
  const step = Math.max(d.width, d.height, 1e-9) / GRID
  w.varint(count)
  let px = 0
  let py = 0
  for (let i = 0; i < count; i++) {
    const x = clamp(Math.round(pts[2 * i] / step), 0, GRID)
    const y = clamp(Math.round(pts[2 * i + 1] / step), 0, GRID)
    w.zigzag(x - px)
    w.zigzag(y - py)
    px = x
    py = y
  }
  let jumps = 0
  for (let i = 0; i < count; i++) jumps += d.path.jump[i] ? 1 : 0
  w.varint(jumps)
  let last = 0
  for (let i = 0; i < count; i++) {
    if (!d.path.jump[i]) continue
    w.varint(i - last)
    last = i
  }
  return w.bytes()
}

/** Inverse of packDrawing. Throws on anything malformed or out of range. */
export function unpackDrawing(bytes: Uint8Array): SharedDrawing {
  const r = new Reader(bytes)
  if (bytes.length < HEADER_BYTES || r.u8() !== MAGIC) throw new Error('This link is not an epicycle drawing')
  const version = r.u8()
  if (version !== VERSION) throw new Error(`This drawing was shared from a newer version (format ${version})`)
  const width = r.f32()
  const height = r.f32()
  if (!(width > 0 && height > 0 && width < 1e7 && height < 1e7)) throw new Error('The shared drawing has a bad size')
  const circles = r.u16()
  const durationSec = r.u16() / 10
  const flags = r.u8()
  const lineWidth = r.u8() / 4
  const followZoom = r.u16() / 10
  const log2n = r.u8()
  if (log2n !== 11 && log2n !== 12 && log2n !== 13) throw new Error('The shared drawing has a bad sample count')

  const count = r.varint()
  if (count < 2 || count > MAX_POINTS) throw new Error('The shared drawing has a bad point count')
  const step = Math.max(width, height) / GRID
  const points = new Float32Array(2 * count)
  let x = 0
  let y = 0
  for (let i = 0; i < count; i++) {
    x += r.zigzag()
    y += r.zigzag()
    if (x < 0 || x > GRID || y < 0 || y > GRID) throw new Error('The shared drawing has a point out of bounds')
    points[2 * i] = x * step
    points[2 * i + 1] = y * step
  }
  const jump = new Uint8Array(count)
  const jumps = r.varint()
  if (jumps > count) throw new Error('The shared drawing has a bad jump count')
  let at = 0
  for (let k = 0; k < jumps; k++) {
    at += r.varint()
    if (at >= count) throw new Error('The shared drawing has a jump out of range')
    jump[at] = 1
  }
  if (r.pos !== bytes.length) throw new Error('The shared drawing has trailing data')

  return {
    width,
    height,
    path: { points, jump },
    sampleCount: (1 << log2n) as SharedDrawing['sampleCount'],
    circles,
    durationSec: Math.max(0.1, durationSec),
    trailMode: flags & 1 ? 'full' : 'fade',
    showCircles: (flags & 2) !== 0,
    showArrows: (flags & 4) !== 0,
    showFormula: (flags & 8) !== 0,
    followTip: (flags & 16) !== 0,
    followZoom: Math.max(0.1, followZoom),
    lineWidth: Math.max(0.25, lineWidth),
  }
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  // slice() gives a plain ArrayBuffer-backed copy that every Response typing accepts.
  const out = new Response(bytes.slice()).body?.pipeThrough(stream)
  if (!out) return new Uint8Array(0)
  const reader = out.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    // Bounds a decompression bomb before it is fully inflated.
    if (total > limit) {
      await reader.cancel()
      throw new Error('The shared drawing is too large')
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    joined.set(c, o)
    o += c.length
  }
  return joined
}

/** Largest packed size: header, 10 bytes per point at worst, the jump list. */
const MAX_PACKED = HEADER_BYTES + 10 + MAX_POINTS * 15

/** Pack and deflate. */
export function encodeDrawing(d: SharedDrawing): Promise<Uint8Array> {
  return pipeThrough(packDrawing(d), new CompressionStream('deflate-raw'), Number.POSITIVE_INFINITY)
}

/** Inflate and unpack. Throws a message fit to show the viewer. */
export async function decodeDrawing(bytes: Uint8Array): Promise<SharedDrawing> {
  if (bytes.length === 0 || bytes.length > MAX_SHARE_BYTES) throw new Error('The shared drawing is empty or too large')
  let packed: Uint8Array
  try {
    packed = await pipeThrough(bytes, new DecompressionStream('deflate-raw'), MAX_PACKED)
  } catch (err) {
    if (err instanceof Error && err.message === 'The shared drawing is too large') throw err
    throw new Error('This link is damaged or incomplete')
  }
  return unpackDrawing(packed)
}

/** base64url without padding, for the URL fragment. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('This link is damaged')
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Short-link id: the first 12 base64url characters of the payload's SHA-256, so one drawing gets one id. */
export async function shareId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  return toBase64Url(digest).slice(0, 12)
}
