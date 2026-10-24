/** In-place radix-2 FFT. Length must be a power of 2. X_k = sum x_j e^{-2 pi i jk/N}. */
export function fft(re: Float64Array, im: Float64Array): void {
  throw new Error('not implemented')
}

/** In-place inverse FFT, including the 1/N factor. */
export function ifft(re: Float64Array, im: Float64Array): void {
  throw new Error('not implemented')
}
