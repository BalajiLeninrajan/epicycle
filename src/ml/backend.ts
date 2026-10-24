export type Backend = 'webgpu' | 'wasm'

/** 'webgpu' when navigator.gpu gives an adapter, else 'wasm'. Cached after the first call. */
export function detectBackend(): Promise<Backend> {
  throw new Error('not implemented')
}
