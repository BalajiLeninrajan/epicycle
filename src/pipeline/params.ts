import type { PipelineSettings } from './types'

export interface DerivedParams {
  lineThreshold: number
  minStrokeLength: number
  simplifyEpsilon: number
  cannySigma: number
  cannyLow: number
  cannyHigh: number
}

/** Map the detail slider and overrides to concrete parameters. */
export function deriveParams(settings: PipelineSettings, width: number, height: number): DerivedParams {
  throw new Error('not implemented')
}
