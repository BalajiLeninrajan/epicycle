import { AutoModel, type PreTrainedModel, Tensor } from '@huggingface/transformers'
import type { GrayImage } from '../pipeline/types'
import { type Backend, detectBackend, ensureRuntime, ORT_RUNTIME_BYTES, webgpuHasF16 } from './backend'
import { createProgress, sharedLoader } from './progress'
import { grayImage, resizePlane, rgbaToChw, sigmoidInPlace } from './tensor'

// BiRefNet-lite (Swin-T backbone). From the Hub repo:
//   preprocessor_config.json: resize to 1024x1024 (aspect not kept), rescale 1/255,
//   ImageNet mean/std normalization.
//   onnx/model.onnx (224 MB fp32) and onnx/model_fp16.onnx (114 MB, float32 I/O).
//   input 'input_image' float32 [1, 3, 1024, 1024] (fixed: other sizes are rejected)
//   output 'output_image' float32 [1, 1, 1024, 1024], logits (the model card applies sigmoid).
//
// WASM can't run it. Measured with onnxruntime-web 1.31 (wasm backend, 1 thread) in node:
// the wasm heap passes 3.6 GiB and the run fails with std::bad_alloc at the 4 GiB wasm32
// limit. That holds for fp16 (CPU arena and memory patterns on or off) and fp32 (both off).
// Since the input size is fixed, a smaller resolution is not an option. On wasm the loader
// rejects, and the app falls back to SAM clicks or the whole image.
const MODEL_ID = 'onnx-community/BiRefNet_lite-ONNX'
const SIZE = 1024
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const
const FILE_BYTES = { fp16: 114_538_221, fp32: 224_005_088 }

let model: PreTrainedModel | null = null

const load = sharedLoader(async (onProgress): Promise<Backend> => {
  const backend = await detectBackend()
  if (backend !== 'webgpu') {
    throw new Error(
      'Automatic subject detection needs WebGPU: BiRefNet does not fit in WebAssembly memory. Click the subject to select it, or keep the background.',
    )
  }
  // shader-f16 is optional in WebGPU; without it the fp16 graph can't run on the GPU.
  const dtype = (await webgpuHasF16()) ? 'fp16' : 'fp32'
  const file = `${MODEL_ID}/onnx/model${dtype === 'fp16' ? '_fp16' : ''}.onnx`
  const progress = createProgress(onProgress, { runtime: ORT_RUNTIME_BYTES, [file]: FILE_BYTES[dtype] })
  try {
    const [, m] = await Promise.all([
      ensureRuntime((l, t) => progress.file('runtime', l, t)).then(() =>
        progress.file('runtime', ORT_RUNTIME_BYTES, ORT_RUNTIME_BYTES),
      ),
      AutoModel.from_pretrained(MODEL_ID, {
        device: 'webgpu',
        dtype,
        progress_callback: (info) => progress.transformers(info, MODEL_ID),
      }),
    ])
    model = m
  } catch (err) {
    throw new Error(`Could not load the subject detection model: ${err instanceof Error ? err.message : String(err)}`)
  }
  progress.done()
  return 'webgpu'
})

/** Load BiRefNet-lite. onProgress gets 0..1. */
export function loadSegmenter(onProgress: (p: number) => void): Promise<Backend> {
  return load(onProgress)
}

/** Foreground probability, same size as the input. */
export async function segment(image: ImageData): Promise<GrayImage> {
  if (!model) throw new Error('Subject detection model is not loaded; call loadSegmenter first')
  const { width, height } = image
  if (width === 0 || height === 0) return grayImage(width, height)
  const input = new Tensor('float32', rgbaToChw(image, SIZE, SIZE, MEAN, STD), [1, 3, SIZE, SIZE])
  const { output_image } = (await model({ input_image: input })) as { output_image?: Tensor }
  if (!output_image) throw new Error('Subject detection returned no output_image')
  const dims = output_image.dims
  const oh = dims[dims.length - 2]
  const ow = dims[dims.length - 1]
  // Resample logits, then squash: edges stay sharper than resampling probabilities.
  const logits = resizePlane(output_image.data as Float32Array, ow, oh, width, height)
  output_image.dispose()
  return grayImage(width, height, sigmoidInPlace(logits))
}
