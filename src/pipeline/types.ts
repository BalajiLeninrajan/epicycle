// Shared data contracts for the image -> single line -> Fourier pipeline.
// All image buffers are row-major, index = y * width + x.

/** Single-channel float image. Values in [0, 1]. */
export interface GrayImage {
  width: number
  height: number
  data: Float32Array
}

/** Binary image. Each value is 0 or 1. */
export interface BinaryImage {
  width: number
  height: number
  data: Uint8Array
}

/**
 * Polyline as interleaved coordinates [x0, y0, x1, y1, ...] in pixel space.
 * A closed polyline repeats its first point as its last point.
 */
export type Polyline = Float32Array

/** One continuous path through every stroke, in pixel space. */
export interface SinglePath {
  /** Interleaved xy, length 2 * count. The path is treated as a closed loop (last point connects back to the first). */
  points: Float32Array
  /** jump[i] = 1 when segment points[i] -> points[i + 1] is a connecting jump, not part of a stroke. Length = count; the last entry is the closing segment back to points[0]. */
  jump: Uint8Array
}

/** Path resampled to n evenly spaced points (by arc length), centered and normalized. */
export interface SampledPath {
  re: Float64Array
  im: Float64Array
  /** jump[i] = 1 when sample i lies on a connecting jump segment. */
  jump: Uint8Array
  /** Pixel coordinates = normalized * scale + center. Normalized points fit inside the unit disk. */
  scale: number
  centerX: number
  centerY: number
}

/** Fourier coefficients, sorted by amplitude, largest first. */
export interface Coeffs {
  /** Frequency n of each term, in [-N/2, N/2). */
  freq: Int32Array
  re: Float64Array
  im: Float64Array
  /** |c_n| */
  amp: Float64Array
  /** Number of samples the coefficients came from. */
  n: number
}

export type LineStyle = 'ai' | 'canny' | 'stipple'

export interface PipelineSettings {
  /** Skip subject masking and draw the whole image. */
  keepBackground: boolean
  lineStyle: LineStyle
  /** 0..1, drives lineThreshold, minStrokeLength and simplifyEpsilon unless they are overridden. */
  detail: number
  /** Advanced overrides. undefined = derived from detail. */
  lineThreshold?: number
  minStrokeLength?: number
  simplifyEpsilon?: number
  includeSilhouette: boolean
  /** Dot count for stipple mode. */
  stippleCount: number
  sampleCount: 2048 | 4096 | 8192
}

export const DEFAULT_SETTINGS: PipelineSettings = {
  keepBackground: false,
  lineStyle: 'ai',
  detail: 0.5,
  includeSilhouette: true,
  stippleCount: 4000,
  sampleCount: 8192,
}

/** A SAM click in normalized image coordinates (0..1). */
export interface SamPoint {
  x: number
  y: number
  positive: boolean
}

export type ModelId = 'segment' | 'sam' | 'lineart'

export type ModelState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number }
  | { status: 'ready'; backend: 'webgpu' | 'wasm' }
  | { status: 'error'; message: string }

export interface PipelineResult {
  width: number
  height: number
  /** Strokes before ordering, for the preview overlay. */
  strokes: Polyline[]
  /** Final ordered path in pixel space, for SVG export. */
  path: SinglePath
  sampled: SampledPath
  coeffs: Coeffs
  /** Which line source was actually used. 'canny' when the AI model is not ready yet. */
  usedLineStyle: LineStyle
  /** Whether a subject mask was applied. */
  masked: boolean
  timings: Record<string, number>
}
