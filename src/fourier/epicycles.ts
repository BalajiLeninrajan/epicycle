import type { Coeffs, SampledPath } from '../pipeline/types'
import { fft, ifft } from './fft'

const TAU = 2 * Math.PI

/** c_n = (1/N) sum z_j e^{-2 pi i n j/N}, sorted by amplitude, largest first. */
export function computeCoeffs(path: SampledPath): Coeffs {
  const n = path.re.length
  const re = Float64Array.from(path.re)
  const im = Float64Array.from(path.im)
  fft(re, im)

  const amp = new Float64Array(n)
  const binFreq = new Int32Array(n)
  const s = 1 / n
  for (let k = 0; k < n; k++) {
    re[k] *= s
    im[k] *= s
    amp[k] = Math.hypot(re[k], im[k])
    binFreq[k] = k < n / 2 ? k : k - n
  }

  // Ties: smaller |n| first, then positive before negative, so the order is fully deterministic.
  const order = new Uint32Array(n)
  for (let k = 0; k < n; k++) order[k] = k
  order.sort((a, b) => {
    const d = amp[b] - amp[a]
    if (d !== 0) return d
    const fa = binFreq[a]
    const fb = binFreq[b]
    const da = Math.abs(fa) - Math.abs(fb)
    return da !== 0 ? da : fb - fa
  })

  const out: Coeffs = {
    freq: new Int32Array(n),
    re: new Float64Array(n),
    im: new Float64Array(n),
    amp: new Float64Array(n),
    n,
  }
  for (let i = 0; i < n; i++) {
    const k = order[i]
    out.freq[i] = binFreq[k]
    out.re[i] = re[k]
    out.im[i] = im[k]
    out.amp[i] = amp[k]
  }
  return out
}

/**
 * Curve from the first k coefficients evaluated at n evenly spaced t, via inverse FFT.
 * Point j is sum c_f e^{2 pi i f j/n}. n must be a power of 2; terms with f outside
 * [-n/2, n/2) would alias at that resolution and are skipped, so pass n >= coeffs.n to keep all.
 */
export function reconstruct(coeffs: Coeffs, k: number, n: number): { re: Float64Array; im: Float64Array } {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`reconstruct: n must be a power of 2 >= 2, got ${n}`)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const count = Math.max(0, Math.min(k, coeffs.freq.length))
  const half = n >> 1
  for (let i = 0; i < count; i++) {
    const f = coeffs.freq[i]
    if (f < -half || f >= half) continue
    const bin = f < 0 ? f + n : f
    // ifft divides by n, so pre-scale to get the plain sum.
    re[bin] += coeffs.re[i] * n
    im[bin] += coeffs.im[i] * n
  }
  ifft(re, im)
  return { re, im }
}

/**
 * Arrow chain at time t in [0, 1): writes the k + 1 joint positions (starting at the origin)
 * into out as interleaved xy. out must have length >= 2 * (k + 1).
 */
export function evalChain(coeffs: Coeffs, k: number, t: number, out: Float64Array): void {
  const count = Math.max(0, Math.min(k, coeffs.freq.length))
  const freq = coeffs.freq
  const cr = coeffs.re
  const ci = coeffs.im
  const w = TAU * t
  let x = 0
  let y = 0
  out[0] = 0
  out[1] = 0
  for (let i = 0; i < count; i++) {
    const a = w * freq[i]
    const c = Math.cos(a)
    const s = Math.sin(a)
    x += cr[i] * c - ci[i] * s
    y += cr[i] * s + ci[i] * c
    out[2 * i + 2] = x
    out[2 * i + 3] = y
  }
  // k beyond the available terms: the extra joints sit on the tip.
  const end = Math.min(k, (out.length >> 1) - 1)
  for (let i = count; i < end; i++) {
    out[2 * i + 2] = x
    out[2 * i + 3] = y
  }
}
