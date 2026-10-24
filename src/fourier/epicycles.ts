import type { Coeffs, SampledPath } from '../pipeline/types'

/** c_n = (1/N) sum z_j e^{-2 pi i n j/N}, sorted by amplitude, largest first. */
export function computeCoeffs(path: SampledPath): Coeffs {
  throw new Error('not implemented')
}

/** Curve from the first k coefficients evaluated at n evenly spaced t, via inverse FFT. */
export function reconstruct(coeffs: Coeffs, k: number, n: number): { re: Float64Array; im: Float64Array } {
  throw new Error('not implemented')
}

/**
 * Arrow chain at time t in [0, 1): writes the k + 1 joint positions (starting at the origin)
 * into out as interleaved xy. out must have length >= 2 * (k + 1).
 */
export function evalChain(coeffs: Coeffs, k: number, t: number, out: Float64Array): void {
  throw new Error('not implemented')
}
