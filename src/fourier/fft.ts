interface Plan {
  /** cos(2 pi k / N), sin(2 pi k / N) for k < N/2 */
  cos: Float64Array
  sin: Float64Array
  rev: Uint32Array
}

const plans = new Map<number, Plan>()

function getPlan(n: number): Plan {
  let plan = plans.get(n)
  if (plan) return plan
  const half = n >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let k = 0; k < half; k++) {
    const a = (2 * Math.PI * k) / n
    cos[k] = Math.cos(a)
    sin[k] = Math.sin(a)
  }
  const rev = new Uint32Array(n)
  let bits = 0
  while (1 << bits < n) bits++
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1)
    rev[i] = r
  }
  plan = { cos, sin, rev }
  plans.set(n, plan)
  return plan
}

/** sign = -1 for forward, +1 for inverse (no scaling). */
function transform(re: Float64Array, im: Float64Array, sign: number): void {
  const n = re.length
  if (im.length !== n) throw new Error(`fft: re/im length mismatch (${n} vs ${im.length})`)
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error(`fft: length must be a power of 2, got ${n}`)
  if (n === 1) return
  const { cos, sin, rev } = getPlan(n)

  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w]
        const wi = sign * sin[w]
        const a = start + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

/** In-place radix-2 FFT. Length must be a power of 2. X_k = sum x_j e^{-2 pi i jk/N}. */
export function fft(re: Float64Array, im: Float64Array): void {
  transform(re, im, -1)
}

/** In-place inverse FFT, including the 1/N factor. */
export function ifft(re: Float64Array, im: Float64Array): void {
  transform(re, im, 1)
  const n = re.length
  const s = 1 / n
  for (let i = 0; i < n; i++) {
    re[i] *= s
    im[i] *= s
  }
}
