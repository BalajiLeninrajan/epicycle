import type { SampledPath, SinglePath } from './types'

/** Resample the closed path to n points evenly spaced by arc length, centered and scaled into the unit disk. */
export function resample(path: SinglePath, n: number): SampledPath {
  n = Math.max(0, Math.floor(n))
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const jump = new Uint8Array(n)
  const pts = path.points
  const c = pts.length >> 1
  if (c === 0 || n === 0) return { re, im, jump, scale: 1, centerX: c ? pts[0] : 0, centerY: c ? pts[1] : 0 }

  // Segment i runs from point i to point (i + 1) % c; the last one closes the loop.
  const segLen = new Float64Array(c)
  let total = 0
  for (let i = 0; i < c; i++) {
    const j = i + 1 === c ? 0 : i + 1
    const dx = pts[2 * j] - pts[2 * i]
    const dy = pts[2 * j + 1] - pts[2 * i + 1]
    const l = Math.sqrt(dx * dx + dy * dy)
    segLen[i] = l
    total += l
  }
  if (!(total > 0) || !Number.isFinite(total)) {
    return { re, im, jump, scale: 1, centerX: pts[0], centerY: pts[1] }
  }

  const step = total / n
  let seg = 0
  let cum = 0
  let sumX = 0
  let sumY = 0
  for (let k = 0; k < n; k++) {
    const s = k * step
    // Zero-length segments are skipped because cum + 0 <= s.
    while (seg < c - 1 && cum + segLen[seg] <= s) cum += segLen[seg++]
    const l = segLen[seg]
    let t = l > 0 ? (s - cum) / l : 0
    if (t > 1) t = 1
    else if (t < 0) t = 0
    const j = seg + 1 === c ? 0 : seg + 1
    const x0 = pts[2 * seg]
    const y0 = pts[2 * seg + 1]
    const x = x0 + (pts[2 * j] - x0) * t
    const y = y0 + (pts[2 * j + 1] - y0) * t
    re[k] = x
    im[k] = y
    jump[k] = path.jump[seg] ? 1 : 0
    sumX += x
    sumY += y
  }

  const centerX = sumX / n
  const centerY = sumY / n
  let maxR2 = 0
  for (let k = 0; k < n; k++) {
    const x = re[k] - centerX
    const y = im[k] - centerY
    re[k] = x
    im[k] = y
    const r2 = x * x + y * y
    if (r2 > maxR2) maxR2 = r2
  }
  if (!(maxR2 > 0)) {
    re.fill(0)
    im.fill(0)
    return { re, im, jump, scale: 1, centerX, centerY }
  }
  const scale = Math.sqrt(maxR2)
  const inv = 1 / scale
  for (let k = 0; k < n; k++) {
    re[k] *= inv
    im[k] *= inv
  }
  return { re, im, jump, scale, centerX, centerY }
}
