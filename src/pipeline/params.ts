import type { PipelineSettings } from './types'

export interface DerivedParams {
  lineThreshold: number
  minStrokeLength: number
  simplifyEpsilon: number
  cannySigma: number
  cannyLow: number
  cannyHigh: number
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * Map the detail slider and overrides to concrete parameters.
 * Every derived value is monotonic in detail (d = detail clamped to 0..1):
 *   lineThreshold    0.35 -> 0.1          lower cutoff keeps fainter ink
 *   minStrokeLength  1.2% -> 0.2% of diag short fragments survive at high detail (>= 2px)
 *   simplifyEpsilon  1.5 -> 0.5 px
 *   cannySigma       2.5 -> 1 px          less blur keeps finer edges
 *   cannyHigh        0.3 -> 0.1, cannyLow = 0.4 * cannyHigh (fractions of the max gradient)
 * Tuned on the line-art model's output: its ink peaks mostly sit between 0.3 and 0.6
 * once upsampled, and sketchy shading breaks into many short strokes, so a cutoff near 0.2
 * and a ~8px minimum at the default detail keep facial features.
 * lineThreshold, minStrokeLength and simplifyEpsilon from settings win when defined.
 */
export function deriveParams(settings: PipelineSettings, width: number, height: number): DerivedParams {
  const raw = Number.isFinite(settings.detail) ? settings.detail : 0.5
  const d = Math.min(1, Math.max(0, raw))
  const diag = Math.hypot(Math.max(0, width), Math.max(0, height))
  const cannyHigh = lerp(0.3, 0.1, d)
  return {
    lineThreshold: settings.lineThreshold ?? lerp(0.35, 0.1, d),
    minStrokeLength: settings.minStrokeLength ?? Math.max(2, diag * lerp(0.012, 0.002, d)),
    simplifyEpsilon: settings.simplifyEpsilon ?? lerp(1.5, 0.5, d),
    cannySigma: lerp(2.5, 1, d),
    cannyLow: 0.4 * cannyHigh,
    cannyHigh,
  }
}
