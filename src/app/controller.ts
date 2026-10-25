// Glue between the signals, the pipeline worker and the renderer.
import { batch, effect } from '@preact/signals'
import { proxy, type Remote } from 'comlink'
import { svgToStrokes } from '../pipeline/svg'
import type { ModelId, PipelineResult, Polyline, SamPoint } from '../pipeline/types'
import { EpicycleRenderer, type RenderOptions } from '../render/epicycles'
import { exportPng, pathToSvg, recordWebm } from '../render/export'
import type { PipelineApi } from '../worker/api'
import { getPipeline, onPipelineFailure } from '../worker/client'
import { baseName, errorMessage, isSvgFile, latestRunner } from './logic'
import {
  error,
  exporting,
  hasDrawing,
  imageSize,
  maskBusy,
  maskEditing,
  maskOutline,
  models,
  pipelineSettings,
  preview,
  render,
  result,
  running,
  samPoints,
  settings,
  source,
  sourceName,
  time,
  type ExportKind,
} from './state'

/** Same cap as the worker, so the mask editor preview matches the working image. */
const MAX_SIDE = 1024
const RUN_DEBOUNCE_MS = 120
const PNG_SIZE = 2048
const AUTO_MODELS: ModelId[] = ['lineart', 'segment']

let pipeline: Remote<PipelineApi> | null = null
let subscribed = false
let modelsStarted = false
let svgData: { strokes: Polyline[]; width: number; height: number } | null = null
let renderer: EpicycleRenderer | null = null
let stageCanvas: HTMLCanvasElement | null = null

onPipelineFailure((message) => {
  batch(() => {
    error.value = message
    running.value = false
    maskBusy.value = false
  })
})

function api(): Remote<PipelineApi> {
  pipeline ??= getPipeline()
  if (!subscribed) {
    subscribed = true
    void pipeline.onModelState(proxy(onModelState))
  }
  return pipeline
}

const runner = latestRunner<PipelineResult>(
  () => {
    const s = pipelineSettings.peek()
    if (source.peek() === 'svg' && svgData) {
      return api().runStrokes(svgData.strokes, svgData.width, svgData.height, s.sampleCount)
    }
    return api().run(s)
  },
  {
    delay: RUN_DEBOUNCE_MS,
    onResult: applyResult,
    onError: (err) => (error.value = errorMessage(err)),
    onBusy: (busy) => (running.value = busy),
  },
)

/** A result that arrived while a WebM was recording; applied when the recording ends. */
let pendingResult: PipelineResult | null = null

function applyResult(r: PipelineResult): void {
  // Swapping the drawing mid-recording would splice two drawings into one video.
  if (exporting.peek() === 'webm') {
    pendingResult = r
    return
  }
  batch(() => {
    result.value = r
    error.value = null
    if (render.circles.peek() > r.coeffs.n) render.circles.value = Math.max(1, r.coeffs.n)
  })
  renderer?.setData(r.coeffs, r.sampled)
}

// Any pipeline setting change schedules a debounced run.
effect(() => {
  void pipelineSettings.value
  if (source.peek() !== 'none') runner.schedule()
})

// Render options go straight to the renderer, one effect per key so only the changed one is sent.
for (const key of Object.keys(render) as (keyof RenderOptions)[]) {
  effect(() => {
    const value = render[key].value
    renderer?.setOptions({ [key]: value } as Partial<RenderOptions>)
  })
}

function currentRenderOptions(): RenderOptions {
  const out = {} as Record<string, unknown>
  for (const key of Object.keys(render) as (keyof RenderOptions)[]) out[key] = render[key].peek()
  return out as unknown as RenderOptions
}

function onModelState(id: ModelId, state: (typeof models.value)[ModelId]): void {
  const prev = models.peek()[id]
  models.value = { ...models.peek(), [id]: state }
  if (state.status !== 'ready' || prev.status === 'ready' || source.peek() !== 'image') return
  // A model that just became ready changes the result: AI lines replace Canny, or the auto mask appears.
  if (id === 'lineart' && settings.lineStyle.peek() === 'ai') runner.flush()
  if (id === 'segment') {
    if (!settings.keepBackground.peek() && samPoints.peek().length === 0) runner.flush()
    if (maskEditing.peek()) void refreshOutline()
  }
}

/** Start (or retry) loading a model. Failures surface through the model state. */
export function loadModel(id: ModelId): void {
  api()
    .loadModel(id)
    .catch(() => {})
}

function startModels(): void {
  if (modelsStarted) return
  modelsStarted = true
  for (const id of AUTO_MODELS) loadModel(id)
}

// ── Sources ───────────────────────────────────────────────────────────────

/** Bumped by every open; an open that finds a newer one started after its awaits gives up. */
let openSeq = 0

/** Thrown by an open that a newer open replaced; callers drop it silently. */
class Superseded extends Error {}

/** Drop in-flight work that belongs to the previous source. */
function resetForNewSource(): void {
  runner.cancel()
  samSeq++
  committedPoints = []
  maskBusy.value = false
  pendingResult = null
}

export async function openFile(file: File): Promise<void> {
  const seq = ++openSeq
  error.value = null
  try {
    if (isSvgFile(file.type, file.name)) {
      const text = await file.text()
      if (seq !== openSeq) return
      openSvg(text, file.name, seq)
    } else if (file.type === '' || file.type.startsWith('image/')) {
      await openImage(file, file.name, seq)
    } else {
      throw new Error(`${file.name || 'That file'} is not an image or SVG`)
    }
  } catch (err) {
    if (seq === openSeq && !(err instanceof Superseded)) error.value = errorMessage(err)
  }
}

async function openImage(blob: Blob, name: string, seq = ++openSeq): Promise<void> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(blob)
  } catch {
    throw new Error(`Could not decode ${name || 'the image'}`)
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height, 1))
    if (scale < 1) {
      const full = bmp
      try {
        bmp = await createImageBitmap(full, {
          resizeWidth: Math.max(1, Math.round(full.width * scale)),
          resizeHeight: Math.max(1, Math.round(full.height * scale)),
          resizeQuality: 'high',
        })
      } finally {
        full.close()
      }
    }
    if (seq !== openSeq) throw new Superseded()
  } catch (err) {
    bmp.close() // a no-op if the resize step already closed it
    throw err
  }
  resetForNewSource()
  // Structured clone: the worker gets its own copy and closes it; ours stays for the mask editor.
  let size: { width: number; height: number }
  try {
    size = await api().setImage(bmp)
  } catch (err) {
    bmp.close()
    throw err
  }
  // A newer open has already called setImage on the worker, or will; leave it to that one.
  if (seq !== openSeq) {
    bmp.close()
    throw new Superseded()
  }
  svgData = null
  batch(() => {
    const old = preview.peek()
    preview.value = bmp
    old?.close()
    imageSize.value = size
    sourceName.value = baseName(name)
    source.value = 'image'
    result.value = null
    samPoints.value = []
    maskOutline.value = []
    maskEditing.value = false
  })
  startModels()
  runner.flush()
}

function openSvg(text: string, name: string, seq = ++openSeq): void {
  const parsed = svgToStrokes(text)
  if (parsed.strokes.length === 0) throw new Error('This SVG has no shapes to draw')
  if (seq !== openSeq) return
  resetForNewSource()
  svgData = parsed
  batch(() => {
    preview.peek()?.close()
    preview.value = null
    imageSize.value = { width: parsed.width, height: parsed.height }
    sourceName.value = baseName(name)
    source.value = 'svg'
    result.value = null
    samPoints.value = []
    maskOutline.value = []
    maskEditing.value = false
  })
  runner.flush()
}

/** Paste event payload: an image file or SVG markup. Returns false when there was nothing usable. */
export function openFromClipboardData(data: DataTransfer | null): boolean {
  if (!data) return false
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && (item.type.startsWith('image/') || item.type === '')) {
      const file = item.getAsFile()
      if (file) {
        void openFile(file)
        return true
      }
    }
  }
  const text = data.getData('text/plain')
  if (/<svg[\s>]/i.test(text)) {
    pasteSvgText(text)
    return true
  }
  return false
}

/** The "Paste" button: reads the async clipboard, which asks for permission. */
export async function pasteFromClipboard(): Promise<void> {
  error.value = null
  try {
    if (!navigator.clipboard?.read) throw new Error('Clipboard access is not available here. Press Ctrl+V or Cmd+V instead.')
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const svgType = item.types.find((t) => t === 'image/svg+xml')
      if (svgType) return pasteSvgText(await (await item.getType(svgType)).text())
      const imageType = item.types.find((t) => t.startsWith('image/'))
      if (imageType) {
        const seq = ++openSeq
        try {
          return await openImage(await item.getType(imageType), 'pasted', seq)
        } catch (err) {
          if (err instanceof Superseded) return
          throw err
        }
      }
      if (item.types.includes('text/plain')) {
        const text = await (await item.getType('text/plain')).text()
        if (/<svg[\s>]/i.test(text)) return pasteSvgText(text)
      }
    }
    throw new Error('The clipboard has no image')
  } catch (err) {
    error.value = err instanceof DOMException && err.name === 'NotAllowedError' ? 'Clipboard access was denied' : errorMessage(err)
  }
}

function pasteSvgText(text: string): void {
  error.value = null
  try {
    openSvg(text, 'pasted.svg')
  } catch (err) {
    error.value = errorMessage(err)
  }
}

// ── Mask editing ──────────────────────────────────────────────────────────

let samSeq = 0
/** Clicks the worker last accepted; a failed update falls back to these. */
let committedPoints: SamPoint[] = []

async function applySamPoints(points: SamPoint[]): Promise<void> {
  samPoints.value = points
  const id = ++samSeq
  maskBusy.value = true
  try {
    const outline = await api().setSamPoints(points)
    if (id !== samSeq) return
    committedPoints = points
    maskOutline.value = outline
    error.value = null
    runner.flush()
  } catch (err) {
    if (id !== samSeq) return
    samPoints.value = committedPoints
    error.value = `Mask: ${errorMessage(err)}`
  } finally {
    if (id === samSeq) maskBusy.value = false
  }
}

async function refreshOutline(): Promise<void> {
  const id = samSeq
  try {
    const outline = await api().getMaskOutline()
    // A click landed meanwhile; its own response carries the newer outline.
    if (id === samSeq) maskOutline.value = outline
  } catch (err) {
    error.value = errorMessage(err)
  }
}

/** x, y normalized to the image (0..1). */
export function addSamPoint(x: number, y: number, positive: boolean): void {
  void applySamPoints([...samPoints.peek(), { x, y, positive }])
}

export function undoSamPoint(): void {
  const pts = samPoints.peek()
  if (pts.length > 0) void applySamPoints(pts.slice(0, -1))
}

export function resetMask(): void {
  if (samPoints.peek().length > 0) void applySamPoints([])
}

export function setMaskEditing(on: boolean): void {
  if (on && source.peek() !== 'image') return
  maskEditing.value = on
  if (on) {
    settings.keepBackground.value = false
    void refreshOutline()
  }
}

// Keeping the background means no mask, so the editor closes.
effect(() => {
  if (settings.keepBackground.value) maskEditing.value = false
})

// ── Renderer ──────────────────────────────────────────────────────────────

let scrubbing = false
let resumeAfterScrub = false

/** Create the renderer on the stage canvas. Returns a cleanup function. */
export function attachStage(canvas: HTMLCanvasElement): () => void {
  const r = new EpicycleRenderer(canvas)
  r.setOptions(currentRenderOptions())
  r.onTime = (t) => {
    if (!scrubbing) time.value = t
  }
  const res = result.peek()
  if (res) r.setData(res.coeffs, res.sampled)
  renderer = r
  stageCanvas = canvas
  return () => {
    r.dispose()
    if (renderer === r) renderer = null
    if (stageCanvas === canvas) stageCanvas = null
  }
}

export function beginScrub(): void {
  if (scrubbing) return
  scrubbing = true
  resumeAfterScrub = render.playing.peek()
  if (resumeAfterScrub) renderer?.setOptions({ playing: false })
}

export function scrubTo(t: number): void {
  time.value = t
  renderer?.seek(t)
}

export function endScrub(): void {
  if (!scrubbing) return
  scrubbing = false
  if (resumeAfterScrub && render.playing.peek()) renderer?.setOptions({ playing: true })
}

// ── Export ────────────────────────────────────────────────────────────────

let recordCancelled = false

export async function exportAs(kind: ExportKind): Promise<void> {
  const r = result.peek()
  if (!r || !hasDrawing.peek() || exporting.peek()) return
  exporting.value = kind
  try {
    let blob: Blob
    let ext: string
    if (kind === 'png') {
      blob = await exportPng(r.coeffs, r.sampled, renderer?.options ?? currentRenderOptions(), PNG_SIZE)
      ext = 'png'
    } else if (kind === 'svg') {
      const svg = pathToSvg(r.path, r.width, r.height, render.hideJumps.peek(), source.peek() === 'image' ? 0.5 : 0)
      blob = new Blob([svg], { type: 'image/svg+xml' })
      ext = 'svg'
    } else {
      if (!renderer || !stageCanvas) throw new Error('The animation is not ready yet')
      recordCancelled = false
      blob = await recordWebm(stageCanvas, renderer)
      if (recordCancelled) return
      ext = 'webm'
    }
    download(blob, `${sourceName.peek()}-fourier.${ext}`)
  } catch (err) {
    error.value = `Export failed: ${errorMessage(err)}`
  } finally {
    exporting.value = null
    const pending = pendingResult
    pendingResult = null
    if (pending) applyResult(pending)
  }
}

/** Stops a WebM recording early and discards it. */
export function cancelRecording(): void {
  if (exporting.peek() !== 'webm') return
  recordCancelled = true
  // Pausing ends playOnce, which ends the recording.
  renderer?.setOptions({ playing: false })
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Some browsers start the download asynchronously; keep the URL alive for a bit.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
