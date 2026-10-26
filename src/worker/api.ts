import type { ModelId, ModelState, PipelineResult, PipelineSettings, Polyline, SamPoint, SinglePath } from '../pipeline/types'

/** RPC surface of the pipeline worker, exposed with Comlink. */
export interface PipelineApi {
  /** Store a new source image (downscaled so the long side is at most 1024px). Clears the mask and all caches. */
  setImage(bitmap: ImageBitmap): Promise<{ width: number; height: number; cutout: boolean }>
  /** Subscribe to model loading state. Pass the callback wrapped in Comlink.proxy. */
  onModelState(cb: (id: ModelId, state: ModelState) => void): void
  /** Use this backend instead of detecting one. Call before any model loads (the ?backend=wasm switch). */
  forceBackend(backend: 'webgpu' | 'wasm'): void
  /** Start loading a model if it is not loaded yet. Resolves when ready. */
  loadModel(id: ModelId): Promise<void>
  /** Replace the SAM clicks. An empty list returns to the automatic mask. Resolves with the mask outline. */
  setSamPoints(points: SamPoint[]): Promise<Polyline[]>
  /** Outline of the current mask for the overlay. Empty when there is no mask. */
  getMaskOutline(): Promise<Polyline[]>
  /** Run the pipeline. Stages whose inputs did not change come from cache. */
  run(settings: PipelineSettings): Promise<PipelineResult>
  /** Skip image processing and run ordering + Fourier on given strokes (SVG mode). */
  runStrokes(strokes: Polyline[], width: number, height: number, sampleCount: number): Promise<PipelineResult>
  /** Skip everything up to ordering and run resample + Fourier on a given path (shared drawings). */
  runPath(path: SinglePath, width: number, height: number, sampleCount: number): Promise<PipelineResult>
}
