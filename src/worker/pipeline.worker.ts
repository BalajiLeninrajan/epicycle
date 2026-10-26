// Pipeline worker entry. Exposes PipelineApi with Comlink.
import { expose } from 'comlink'
import type { Backend } from '../ml/backend'
import { lineArt, loadLineArt, resetLineArt } from '../ml/lineart'
import { loadSam, samPredict, samSetImage } from '../ml/sam'
import { loadSegmenter, resetSegmenter, segment } from '../ml/segment'
import { createPipeline } from '../pipeline/pipeline'
import type { ModelId, ModelState } from '../pipeline/types'
import type { PipelineApi } from './api'

const MAX_SIDE = 1024

const loaders: Record<ModelId, (onProgress: (p: number) => void) => Promise<Backend>> = {
  segment: loadSegmenter,
  sam: loadSam,
  lineart: loadLineArt,
}

const states: Record<ModelId, ModelState> = {
  segment: { status: 'idle' },
  sam: { status: 'idle' },
  lineart: { status: 'idle' },
}
const loading: Partial<Record<ModelId, Promise<void>>> = {}
let listener: ((id: ModelId, state: ModelState) => void) | null = null

function report(id: ModelId, state: ModelState): void {
  states[id] = state
  // The listener is a Comlink proxy; its call returns a promise we do not need.
  if (listener) void listener(id, state)
}

const pipeline = createPipeline({
  segment,
  lineArt,
  samSetImage,
  samPredict,
  segmenterReady: () => states.segment.status === 'ready',
  lineArtReady: () => states.lineart.status === 'ready',
  loadSam: () => loadModel('sam'),
  onInferenceError(id, err) {
    // Drop the session (a lost WebGPU device won't recover) and forget the finished load,
    // so Retry goes through loadModel and builds a new one.
    ;(id === 'segment' ? resetSegmenter : resetLineArt)()
    delete loading[id]
    report(id, { status: 'error', message: err instanceof Error ? err.message : String(err) })
  },
})

function loadModel(id: ModelId): Promise<void> {
  let p = loading[id]
  if (p) return p
  report(id, { status: 'loading', progress: 0 })
  let last = 0
  const onProgress = (v: number) => {
    const progress = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
    // Throttle to 1% steps; ignore stragglers after the load settled.
    if (states[id].status !== 'loading' || Math.abs(progress - last) < 0.01) return
    last = progress
    report(id, { status: 'loading', progress })
  }
  p = Promise.resolve().then(() => loaders[id](onProgress)).then(
    (backend) => report(id, { status: 'ready', backend }),
    (err: unknown) => {
      delete loading[id]
      report(id, { status: 'error', message: err instanceof Error ? err.message : String(err) })
      throw err
    },
  )
  loading[id] = p
  return p
}

function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height, 1))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas context unavailable in worker')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

// Results go back by structured clone (no Comlink.transfer), so cached buffers stay intact here.
const api: PipelineApi = {
  async setImage(bitmap) {
    try {
      return pipeline.setImage(bitmapToImageData(bitmap))
    } finally {
      bitmap.close()
    }
  },

  onModelState(cb) {
    listener = cb
    for (const id of Object.keys(states) as ModelId[]) void cb(id, states[id])
  },

  loadModel,

  setSamPoints: (points) => pipeline.setSamPoints(points),

  getMaskOutline: () => pipeline.getMaskOutline(),

  run: (settings) => pipeline.run(settings),

  async runStrokes(strokes, width, height, sampleCount) {
    return pipeline.runStrokes(strokes, width, height, sampleCount)
  },

  async runPath(path, width, height, sampleCount) {
    return pipeline.runPath(path, width, height, sampleCount)
  },
}

expose(api)
