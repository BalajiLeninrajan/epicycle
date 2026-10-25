import type { GrayImage } from '../pipeline/types'
import { type Backend, detectBackend, ensureRuntime, ort, ORT_RUNTIME_BYTES } from './backend'
import { fetchCached } from './fetch'
import { createProgress, sharedLoader } from './progress'
import { grayImage, resizePlane, rgbaToChw } from './tensor'

// MODNet portrait matting (Xenova/modnet, Apache-2.0). From the Hub repo:
//   preprocessor_config.json: resize so the short edge is 512, sides divisible by 32,
//   rescale 1/255, normalize with mean 0.5 / std 0.5.
//   input 'input' float32 [batch, 3, height, width], dynamic size
//   output 'output' float32 [batch, 1, height, width], alpha in [0, 1] (the graph ends in Sigmoid)
// We use fp32 on both backends: the quantized file lets background through on portraits.
// On a 768x512 input, CPU ORT peaks at about 270 MB RSS and takes about 0.3s.
//
// BiRefNet-lite was the first choice. It was dropped because it is too heavy for the
// devices this targets: on wasm it passes the 4 GiB heap limit at its fixed 1024x1024
// input, and on an 8 GB laptop with an integrated GPU it got the browser OOM-killed.
const MODEL_URL = 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx'
const MODEL_BYTES = 25_888_640
const SHORT_EDGE = 512
const MULTIPLE = 32
// Bounds the input for very wide or tall images.
const MAX_LONG_EDGE = 1024

let session: ort.InferenceSession | null = null

async function createSession(bytes: Uint8Array, backend: Backend): Promise<Backend> {
  if (backend === 'webgpu') {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' })
      return 'webgpu'
    } catch (err) {
      console.warn('Subject model: WebGPU session failed, falling back to wasm', err)
    }
  }
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  return 'wasm'
}

const load = sharedLoader(async (onProgress): Promise<Backend> => {
  try {
    const backend = await detectBackend()
    const progress = createProgress(onProgress, { runtime: ORT_RUNTIME_BYTES, model: MODEL_BYTES })
    const [, bytes] = await Promise.all([
      ensureRuntime((l, t) => progress.file('runtime', l, t)).then(() =>
        progress.file('runtime', ORT_RUNTIME_BYTES, ORT_RUNTIME_BYTES),
      ),
      fetchCached(MODEL_URL, (l, t) => progress.file('model', l, t)),
    ])
    const used = await createSession(bytes, backend)
    progress.done()
    return used
  } catch (err) {
    throw new Error(`Could not load the subject detection model: ${err instanceof Error ? err.message : String(err)}`)
  }
})

/** Load MODNet. onProgress gets 0..1. */
export function loadSegmenter(onProgress: (p: number) => void): Promise<Backend> {
  return load(onProgress)
}

/** Model input size: short edge 512, long edge capped, both multiples of 32. */
export function inputSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(SHORT_EDGE / Math.min(width, height), MAX_LONG_EDGE / Math.max(width, height))
  const round = (v: number) => Math.max(MULTIPLE, Math.round((v * scale) / MULTIPLE) * MULTIPLE)
  return { width: round(width), height: round(height) }
}

/** Foreground probability, same size as the input. */
export async function segment(image: ImageData): Promise<GrayImage> {
  if (!session) throw new Error('Subject detection model is not loaded; call loadSegmenter first')
  const { width, height } = image
  if (width === 0 || height === 0) return grayImage(width, height)
  const size = inputSize(width, height)
  const input = new ort.Tensor('float32', rgbaToChw(image, size.width, size.height, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), [
    1,
    3,
    size.height,
    size.width,
  ])
  const outputs = await session.run({ input })
  const out = outputs.output
  try {
    if (!out) throw new Error('Subject detection returned no output')
    const [, , oh, ow] = out.dims
    return grayImage(width, height, resizePlane(out.data as Float32Array, ow, oh, width, height))
  } finally {
    input.dispose()
    out?.dispose()
  }
}
