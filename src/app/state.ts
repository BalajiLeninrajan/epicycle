// App state as signals. Each control binds to its own signal, so a slider only re-renders itself.
import { computed, signal, type Signal } from '@preact/signals'
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from '../render/epicycles'
import {
  DEFAULT_SETTINGS,
  type ModelId,
  type ModelState,
  type PipelineResult,
  type PipelineSettings,
  type Polyline,
  type SamPoint,
} from '../pipeline/types'

type Signals<T> = { [K in keyof T]-?: Signal<T[K]> }

/** One signal per key. Optional keys must be present in init (as undefined) to get a signal. */
function signalsOf<T extends object>(init: T): Signals<T> {
  const out = {} as Record<string, Signal<unknown>>
  for (const key of Object.keys(init)) out[key] = signal((init as Record<string, unknown>)[key])
  return out as Signals<T>
}

export const settings = signalsOf<PipelineSettings>({
  ...DEFAULT_SETTINGS,
  lineThreshold: undefined,
  minStrokeLength: undefined,
  simplifyEpsilon: undefined,
})

/** Snapshot of every pipeline setting; reading it subscribes to all of them. */
export const pipelineSettings = computed<PipelineSettings>(() => ({
  keepBackground: settings.keepBackground.value,
  lineStyle: settings.lineStyle.value,
  detail: settings.detail.value,
  lineThreshold: settings.lineThreshold.value,
  minStrokeLength: settings.minStrokeLength.value,
  simplifyEpsilon: settings.simplifyEpsilon.value,
  includeSilhouette: settings.includeSilhouette.value,
  stippleCount: settings.stippleCount.value,
  sampleCount: settings.sampleCount.value,
}))

export const render = signalsOf<RenderOptions>({ ...DEFAULT_RENDER_OPTIONS })

export type SourceKind = 'none' | 'image' | 'svg'

export const source = signal<SourceKind>('none')
/** Name of the uploaded file, used for download names. */
export const sourceName = signal('drawing')
/** Size of the working image (after the worker downscale) or of the SVG viewBox. */
export const imageSize = signal<{ width: number; height: number } | null>(null)
/** Downscaled copy of the photo for the mask editor. */
export const preview = signal<ImageBitmap | null>(null)

export const result = signal<PipelineResult | null>(null)
export const running = signal(false)
export const error = signal<string | null>(null)

const idle: ModelState = { status: 'idle' }
export const models = signal<Record<ModelId, ModelState>>({ segment: idle, sam: idle, lineart: idle })

export const maskEditing = signal(false)
/** Touch-friendly alternative to shift-click. */
export const removeMode = signal(false)
export const samPoints = signal<SamPoint[]>([])
export const maskOutline = signal<Polyline[]>([])
export const maskBusy = signal(false)

export const showStrokes = signal(false)

/** Animation time in [0, 1), pushed from renderer.onTime. */
export const time = signal(0)

export type ExportKind = 'png' | 'webm' | 'svg'
export const exporting = signal<ExportKind | null>(null)
export const recording = computed(() => exporting.value === 'webm')

/** Max circle count for the current result. */
export const maxCircles = computed(() => Math.max(1, result.value?.coeffs.n ?? 4096))

/** The result has a drawable path. */
export const hasDrawing = computed(() => (result.value?.path.points.length ?? 0) >= 4)
