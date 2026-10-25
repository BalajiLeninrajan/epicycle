import type { GrayImage, SamPoint } from '../pipeline/types'
import { type Backend, detectBackend, ensureRuntime, ort, ORT_RUNTIME_BYTES } from './backend'
import { fetchCached } from './fetch'
import { createProgress, sharedLoader } from './progress'
import { grayImage, rgbaToChw, sigmoidInPlace } from './tensor'

// MobileSAM (Acly/MobileSAM, MIT), the TinyViT encoder distilled from SAM plus SAM's mask
// decoder. Verified with onnxruntime:
//   image encoder: 'input_image' float32 [H, W, 3], RGB in 0..255 with the long side resized
//     to 1024. The graph normalizes, transposes and pads to 1024x1024 itself.
//     -> 'image_embeddings' [1, 256, 64, 64]
//   mask decoder (multi): 'image_embeddings', 'point_coords' [1, n, 2] in resized-image pixels,
//     'point_labels' [1, n] float (1 = include, 0 = exclude, -1 = padding), 'mask_input'
//     [1, 1, 256, 256], 'has_mask_input' [1], 'orig_im_size' [2] = (h, w)
//     -> 'masks' [1, 4, h, w] logits at orig_im_size, 'iou_predictions' [1, 4]
// Mask 0 is the single-mask answer; 1..3 are the multimask candidates, which suit a lone
// click better since one point is ambiguous.
//
// SlimSAM was used before. Its encoder peaked at ~1.8 GB on CPU (global attention over 4096
// tokens) and got the browser OOM-killed on an 8 GB laptop; MobileSAM peaks at ~360 MB.
const BASE = 'https://huggingface.co/Acly/MobileSAM/resolve/main/'
const ENCODER = { url: `${BASE}mobile_sam_image_encoder.onnx`, bytes: 28_157_093 }
const DECODER = { url: `${BASE}sam_mask_decoder_multi.onnx`, bytes: 16_496_559 }
const LONG_SIDE = 1024

interface Embedding {
  width: number
  height: number
  /** Size of the resized image the encoder saw (long side 1024). */
  inW: number
  inH: number
  embeddings: ort.Tensor
}

let encoder: ort.InferenceSession | null = null
let decoder: ort.InferenceSession | null = null
let embedding: Promise<Embedding> | null = null

async function createSessions(enc: Uint8Array, dec: Uint8Array, backend: Backend): Promise<Backend> {
  if (backend === 'webgpu') {
    try {
      encoder = await ort.InferenceSession.create(enc, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' })
      // The decoder is small and runs per click; wasm avoids GPU readback round trips.
      decoder = await ort.InferenceSession.create(dec, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
      return 'webgpu'
    } catch (err) {
      console.warn('SAM: WebGPU session failed, falling back to wasm', err)
      await encoder?.release()
      encoder = null
    }
  }
  encoder = await ort.InferenceSession.create(enc, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  decoder ??= await ort.InferenceSession.create(dec, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  return 'wasm'
}

const load = sharedLoader(async (onProgress): Promise<Backend> => {
  try {
    const backend = await detectBackend()
    const progress = createProgress(onProgress, {
      runtime: ORT_RUNTIME_BYTES,
      encoder: ENCODER.bytes,
      decoder: DECODER.bytes,
    })
    const [, enc, dec] = await Promise.all([
      ensureRuntime((l, t) => progress.file('runtime', l, t)).then(() =>
        progress.file('runtime', ORT_RUNTIME_BYTES, ORT_RUNTIME_BYTES),
      ),
      fetchCached(ENCODER.url, (l, t) => progress.file('encoder', l, t)),
      fetchCached(DECODER.url, (l, t) => progress.file('decoder', l, t)),
    ])
    const used = await createSessions(enc, dec, backend)
    progress.done()
    return used
  } catch (err) {
    throw new Error(`Could not load the click-to-select model: ${err instanceof Error ? err.message : String(err)}`)
  }
})

/** Load MobileSAM. onProgress gets 0..1. */
export function loadSam(onProgress: (p: number) => void): Promise<Backend> {
  return load(onProgress)
}

/** Encoder input size: long side 1024, aspect kept. */
export function samInputSize(width: number, height: number): { width: number; height: number } {
  const s = LONG_SIDE / Math.max(width, height)
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) }
}

async function embed(enc: ort.InferenceSession, image: ImageData): Promise<Embedding> {
  const { width, height } = image
  const size = samInputSize(width, height)
  // rgbaToChw with std 1/255 keeps 0..255 values; the encoder wants them interleaved (HWC).
  const chw = rgbaToChw(image, size.width, size.height, [0, 0, 0], [1 / 255, 1 / 255, 1 / 255])
  const plane = size.width * size.height
  const hwc = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    hwc[3 * i] = chw[i]
    hwc[3 * i + 1] = chw[plane + i]
    hwc[3 * i + 2] = chw[2 * plane + i]
  }
  const input = new ort.Tensor('float32', hwc, [size.height, size.width, 3])
  try {
    const out = await enc.run({ input_image: input })
    return { width, height, inW: size.width, inH: size.height, embeddings: out.image_embeddings }
  } finally {
    input.dispose()
  }
}

/** Compute and cache image embeddings. */
export function samSetImage(image: ImageData): Promise<void> {
  if (!encoder) return Promise.reject(new Error('SAM is not loaded; call loadSam first'))
  if (image.width === 0 || image.height === 0) return Promise.reject(new Error('SAM needs a non-empty image'))
  // The embeddings are a 4 MB CPU tensor; older ones are left to GC, since a prediction
  // for the previous image may still be reading them.
  const p = embed(encoder, image)
  embedding = p
  p.catch(() => {
    if (embedding === p) embedding = null
  })
  return p.then(() => {})
}

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)

/** Mask probability for the clicks, same size as the image passed to samSetImage. */
export async function samPredict(points: SamPoint[]): Promise<GrayImage> {
  if (!decoder) throw new Error('SAM is not loaded; call loadSam first')
  if (!embedding) throw new Error('samPredict called before samSetImage')
  const e = await embedding
  if (points.length === 0) return grayImage(e.width, e.height)

  // One padding point (label -1) stands in for the missing box prompt.
  const n = points.length + 1
  const coords = new Float32Array(2 * n)
  const labels = new Float32Array(n)
  for (let i = 0; i < points.length; i++) {
    coords[2 * i] = clamp01(points[i].x) * e.inW
    coords[2 * i + 1] = clamp01(points[i].y) * e.inH
    labels[i] = points[i].positive ? 1 : 0
  }
  labels[n - 1] = -1
  const feeds = {
    image_embeddings: e.embeddings,
    point_coords: new ort.Tensor('float32', coords, [1, n, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, n]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', new Float32Array(1), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([e.height, e.width]), [2]),
  }
  const out = await decoder.run(feeds)
  try {
    const iou = out.iou_predictions.data as Float32Array
    const best = points.length === 1 ? pickMultimask(iou) : 0
    const plane = e.width * e.height
    const logits = (out.masks.data as Float32Array).slice(best * plane, (best + 1) * plane)
    return grayImage(e.width, e.height, sigmoidInPlace(logits))
  } finally {
    for (const [k, t] of Object.entries(feeds)) if (k !== 'image_embeddings') t.dispose()
    out.masks.dispose()
    out.iou_predictions.dispose()
    out.low_res_masks?.dispose()
  }
}

/** Best of the multimask candidates 1..3 by predicted IoU. */
export function pickMultimask(iou: ArrayLike<number>): number {
  let best = 1
  for (let i = 2; i < Math.min(4, iou.length); i++) if (iou[i] > iou[best]) best = i
  return best
}
