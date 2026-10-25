import { AutoProcessor, type Processor, type ProgressInfo, RawImage, SamModel, Tensor } from '@huggingface/transformers'
import type { GrayImage, SamPoint } from '../pipeline/types'
import { type Backend, detectBackend, ensureRuntime, ORT_RUNTIME_BYTES } from './backend'
import { createProgress, type Progress, sharedLoader } from './progress'
import { argmax, grayImage, resizePlane, sigmoidInPlace } from './tensor'

// SlimSAM-77 (uniform pruning). From the Hub repo:
//   preprocessor_config.json: longest edge 1024, pad bottom/right to 1024x1024, ImageNet mean/std.
//   vision_encoder: pixel_values [1,3,1024,1024] -> image_embeddings, image_positional_embeddings [1,256,64,64]
//   prompt_encoder_mask_decoder: input_points [1,1,n,2] (resized-image pixels), input_labels [1,1,n]
//     (int64, 1 = include, 0 = exclude) -> iou_scores [1,1,3], pred_masks [1,1,3,256,256] logits
//     over the padded 1024x1024 frame.
// dtype: q8 ("_quantized", 13.8 MB total) on wasm. fp32 (39.8 MB) on WebGPU: the fp16 exports
// are half the size but SAM's fp16 mask decoder is known to give broken masks.
const MODEL_ID = 'Xenova/slimsam-77-uniform'
const FILES = {
  webgpu: { 'onnx/vision_encoder.onnx': 23_276_014, 'onnx/prompt_encoder_mask_decoder.onnx': 16_557_892 },
  wasm: { 'onnx/vision_encoder_quantized.onnx': 8_882_165, 'onnx/prompt_encoder_mask_decoder_quantized.onnx': 4_903_810 },
}

interface Embedding {
  width: number
  height: number
  /** Size of the image inside the padded model frame. */
  inW: number
  inH: number
  padW: number
  padH: number
  image_embeddings: Tensor
  image_positional_embeddings: Tensor
}

let model: SamModel | null = null
let processor: Processor | null = null
let embedding: Promise<Embedding> | null = null

async function loadOn(backend: Backend, progress: Progress): Promise<void> {
  const expected = FILES[backend]
  for (const [f, size] of Object.entries(expected)) progress.file(`${MODEL_ID}/${f}`, 0, size)
  model = (await SamModel.from_pretrained(MODEL_ID, {
    device: backend,
    dtype: backend === 'webgpu' ? 'fp32' : 'q8',
    progress_callback: (info) => progress.transformers(info, MODEL_ID),
  })) as SamModel
}

const load = sharedLoader(async (onProgress): Promise<Backend> => {
  const progress = createProgress(onProgress, { runtime: ORT_RUNTIME_BYTES })
  try {
    let backend = await detectBackend()
    const proc = AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback: (info: ProgressInfo) => progress.transformers(info, MODEL_ID),
    })
    proc.catch(() => {}) // awaited below; don't report it as unhandled if the model fails first
    // The runtime comes first and on its own: a runtime failure is not a WebGPU failure, and
    // falling back while the WebGPU load kept running would leave two models racing.
    await ensureRuntime((l, t) => progress.file('runtime', l, t))
    progress.file('runtime', ORT_RUNTIME_BYTES, ORT_RUNTIME_BYTES)
    try {
      await loadOn(backend, progress)
    } catch (err) {
      if (backend !== 'webgpu') throw err
      console.warn('SAM: WebGPU load failed, falling back to wasm', err)
      backend = 'wasm'
      await loadOn(backend, progress)
    }
    processor = await proc
    progress.done()
    return backend
  } catch (err) {
    throw new Error(`Could not load the click-to-select model: ${err instanceof Error ? err.message : String(err)}`)
  }
})

/** Load SlimSAM. onProgress gets 0..1. */
export function loadSam(onProgress: (p: number) => void): Promise<Backend> {
  return load(onProgress)
}

/** RGBA composited over white, as 3-channel RGB. Matches what the other models see. */
function toRgb(image: ImageData): Uint8ClampedArray {
  const src = image.data
  const out = new Uint8ClampedArray((src.length / 4) * 3)
  for (let i = 0, j = 0; j < src.length; i += 3, j += 4) {
    const a = src[j + 3]
    if (a === 255) {
      out[i] = src[j]
      out[i + 1] = src[j + 1]
      out[i + 2] = src[j + 2]
    } else {
      const k = a / 255
      const bg = 255 - a
      out[i] = src[j] * k + bg
      out[i + 1] = src[j + 1] * k + bg
      out[i + 2] = src[j + 2] * k + bg
    }
  }
  return out
}

async function embed(m: SamModel, proc: Processor, image: ImageData): Promise<Embedding> {
  const { width, height } = image
  const inputs = (await proc(new RawImage(toRgb(image), width, height, 3))) as {
    pixel_values: Tensor
    reshaped_input_sizes: [number, number][]
  }
  const [inH, inW] = inputs.reshaped_input_sizes[0]
  const pad = (proc.image_processor as { pad_size?: { width: number; height: number } } | undefined)?.pad_size
  const { image_embeddings, image_positional_embeddings } = await m.get_image_embeddings({
    pixel_values: inputs.pixel_values,
  })
  inputs.pixel_values.dispose()
  return {
    width,
    height,
    inW,
    inH,
    padW: pad?.width ?? 1024,
    padH: pad?.height ?? 1024,
    image_embeddings,
    image_positional_embeddings,
  }
}

/** Compute and cache image embeddings. */
export function samSetImage(image: ImageData): Promise<void> {
  if (!model || !processor) return Promise.reject(new Error('SAM is not loaded; call loadSam first'))
  if (image.width === 0 || image.height === 0) return Promise.reject(new Error('SAM needs a non-empty image'))
  const p = embed(model, processor, image)
  embedding = p
  p.catch(() => {
    if (embedding === p) embedding = null
  })
  return p.then(() => {})
}

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)

/** Mask probability for the clicks, same size as the image passed to samSetImage. */
export async function samPredict(points: SamPoint[]): Promise<GrayImage> {
  if (!model) throw new Error('SAM is not loaded; call loadSam first')
  if (!embedding) throw new Error('samPredict called before samSetImage')
  const e = await embedding
  if (points.length === 0) return grayImage(e.width, e.height)

  const n = points.length
  const coords = new Float32Array(2 * n)
  const labels = new BigInt64Array(n)
  for (let i = 0; i < n; i++) {
    // Normalized image coords -> pixels of the resized (unpadded) model input.
    coords[2 * i] = clamp01(points[i].x) * e.inW
    coords[2 * i + 1] = clamp01(points[i].y) * e.inH
    labels[i] = points[i].positive ? 1n : 0n
  }
  const out = (await model({
    image_embeddings: e.image_embeddings,
    image_positional_embeddings: e.image_positional_embeddings,
    input_points: new Tensor('float32', coords, [1, 1, n, 2]),
    input_labels: new Tensor('int64', labels, [1, 1, n]),
  })) as { iou_scores: Tensor; pred_masks: Tensor }

  const dims = out.pred_masks.dims
  const mh = dims[dims.length - 2]
  const mw = dims[dims.length - 1]
  const count = dims[dims.length - 3] ?? 1
  const best = Math.max(0, argmax(out.iou_scores.data as Float32Array, 0, count))
  const plane = (out.pred_masks.data as Float32Array).subarray(best * mh * mw, (best + 1) * mh * mw)
  // The low-res mask covers the padded frame; keep the part that holds the image.
  const logits = resizePlane(plane, mw, mh, e.width, e.height, (e.inW * mw) / e.padW, (e.inH * mh) / e.padH)
  out.pred_masks.dispose()
  out.iou_scores.dispose()
  return grayImage(e.width, e.height, sigmoidInPlace(logits))
}
