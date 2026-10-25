import type { GrayImage } from '../pipeline/types'
import { type Backend, detectBackend, ensureRuntime, ort, ORT_RUNTIME_BYTES } from './backend'
import { fetchCached } from './fetch'
import { createProgress, sharedLoader } from './progress'
import { fitSize, grayImage, invertUnitInPlace, resizePlane, rgbaToChw } from './tensor'

// Informative Drawings, "line art" style (carolineec/informative-drawings, pix2pix-style
// generator with InstanceNorm), ONNX export by rocca. Verified with onnxruntime-web:
//   input  'input'  float32 [batch, 3, height, width], RGB in [0, 1], no mean/std
//   output 'output' float32 [batch, 1, height, width], in [0, 1], 1 = white paper, low = ink
// Spatial dims are dynamic but get rounded up to a multiple of 4, so we feed multiples of 8.
const MODEL_URL = 'https://huggingface.co/rocca/informative-drawings-line-art-onnx/resolve/main/model.onnx'
const MODEL_BYTES = 17_193_338
// The model was trained on 256px crops. 512 on the long side keeps lines thin enough to
// trace on a 1024px image while keeping wasm inference to a few seconds.
const LONG_SIDE = 512
const MULTIPLE = 8

let session: ort.InferenceSession | null = null

async function createSession(bytes: Uint8Array, backend: Backend): Promise<Backend> {
  if (backend === 'webgpu') {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' })
      return 'webgpu'
    } catch (err) {
      console.warn('Line art: WebGPU session failed, falling back to wasm', err)
    }
  }
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  return 'wasm'
}

const load = sharedLoader(async (onProgress) => {
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
    throw new Error(`Could not load the line-art model: ${err instanceof Error ? err.message : String(err)}`)
  }
})

/** Load Informative Drawings (line art). onProgress gets 0..1. */
export function loadLineArt(onProgress: (p: number) => void): Promise<Backend> {
  return load(onProgress)
}

/** Line drawing, same size as the input. 1 = ink, 0 = paper. */
export async function lineArt(image: ImageData): Promise<GrayImage> {
  if (!session) throw new Error('Line-art model is not loaded; call loadLineArt first')
  const { width, height } = image
  if (width === 0 || height === 0) return grayImage(width, height)
  const size = fitSize(width, height, LONG_SIDE, MULTIPLE)
  const input = new ort.Tensor('float32', rgbaToChw(image, size.width, size.height), [1, 3, size.height, size.width])
  const outputs = await session.run({ input })
  const out = outputs.output
  try {
    const [, , oh, ow] = out.dims
    const ink = resizePlane(out.data as Float32Array, ow, oh, width, height)
    return grayImage(width, height, invertUnitInPlace(ink))
  } finally {
    input.dispose()
    out.dispose()
  }
}
