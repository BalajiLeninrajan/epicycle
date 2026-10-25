import { env as hfEnv } from '@huggingface/transformers'
// transformers.js imports this exact entry, so both share one ORT instance and one env.
import * as ort from 'onnxruntime-web/webgpu'
import { fetchCached } from './fetch'

export type Backend = 'webgpu' | 'wasm'

interface GpuLike {
  requestAdapter(): Promise<object | null>
}

let backend: Promise<Backend> | null = null

async function probe(): Promise<Backend> {
  try {
    const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu
    // Same default adapter query ORT's WebGPU EP makes. Every model runs fp32 on WebGPU,
    // so no optional features need checking.
    return (await gpu?.requestAdapter()) ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

/** 'webgpu' when navigator.gpu gives an adapter, else 'wasm'. Cached after the first call. */
export function detectBackend(): Promise<Backend> {
  return (backend ??= probe())
}

// Runtime files. The asyncify build is the one the webgpu entry loads; it carries both the
// WebGPU and the CPU (wasm) execution providers. It is 26,861,777 bytes, over Cloudflare's
// 25 MiB (26,214,400) per-asset limit, so we can't ship it as a static asset. We load it
// from jsDelivr at the exact installed version instead. jsDelivr sends CORS headers, which
// COEP require-corp needs. Both files go through the Cache API so repeat visits work offline.
export const ORT_VERSION: string = ort.env.versions.web ?? ''
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`
const ORT_WASM = `${ORT_CDN}ort-wasm-simd-threaded.asyncify.wasm`
const ORT_MJS = `${ORT_CDN}ort-wasm-simd-threaded.asyncify.mjs`
const WASM_BYTES = 26_861_777
const MJS_BYTES = 53_057
/** Download size of the runtime, for progress weighting. */
export const ORT_RUNTIME_BYTES = WASM_BYTES + MJS_BYTES

let configured = false

/** Configure ORT and transformers.js once. Safe to call repeatedly. */
export function configureOrt(): void {
  if (configured) return
  configured = true
  const hc = globalThis.navigator?.hardwareConcurrency ?? 1
  // Threads need SharedArrayBuffer, which needs cross-origin isolation (COOP/COEP).
  // Leave a core for the UI thread; ORT gains little past 4.
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, hc - 1)) : 1
  ort.env.wasm.proxy = false // we already run in a worker
  // ORT logs graph optimizer notes as warnings on every session create.
  ort.env.logLevel = 'error'
  ort.env.wasm.wasmPaths = { mjs: ORT_MJS, wasm: ORT_WASM }
  // ensureRuntime() caches the runtime itself; skip transformers.js's copy of it.
  hfEnv.useWasmCache = false
  hfEnv.allowLocalModels = false
  hfEnv.useBrowserCache = true
  installSessionLock()
}

let runtime: Promise<void> | null = null
const runtimeListeners = new Set<(loaded: number, total: number) => void>()

/**
 * Download (or read from cache) the ORT runtime and point ORT at it. Must finish before
 * the first session is created. onBytes follows the download if this call joins one in flight.
 */
export function ensureRuntime(onBytes?: (loaded: number, total: number) => void): Promise<void> {
  configureOrt()
  if (onBytes) runtimeListeners.add(onBytes)
  runtime ??= (async () => {
    const bytes = { wasm: 0, mjs: 0 }
    const sizes = { wasm: WASM_BYTES, mjs: MJS_BYTES }
    const report = (key: 'wasm' | 'mjs') => (loaded: number, total: number) => {
      bytes[key] = loaded
      if (total > 0) sizes[key] = total
      for (const l of runtimeListeners) l(bytes.wasm + bytes.mjs, sizes.wasm + sizes.mjs)
    }
    try {
      const [wasm, mjs] = await Promise.all([fetchCached(ORT_WASM, report('wasm')), fetchCached(ORT_MJS, report('mjs'))])
      ort.env.wasm.wasmBinary = wasm
      // A blob URL keeps the factory same-origin, so ORT can start its thread workers from it.
      // ORT only accepts a blob factory when wasmBinary is set.
      const factory = URL.createObjectURL(new Blob([mjs], { type: 'text/javascript' }))
      ort.env.wasm.wasmPaths = { mjs: factory, wasm: ORT_WASM }
    } catch (err) {
      runtime = null
      throw new Error(`Could not load the ONNX Runtime: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      runtimeListeners.clear()
    }
  })()
  return runtime
}

let chain: Promise<unknown> = Promise.resolve()

/** Run fn after every earlier exclusive() call settles. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.then(
    () => {},
    () => {},
  )
  return p
}

let lockInstalled = false

// The webgpu build of ORT uses asyncify, which can't have two suspended calls into the wasm
// module at once: overlapping session.create / session.run calls corrupt it ("Session already
// started"). transformers.js serializes its own creates and its own runs on two separate
// chains, but knows nothing about our direct ORT sessions. Wrapping ORT's own entry points
// puts every create and run, from either library, on one queue. Both libraries download
// model files before calling create, so a large download does not block inference.
function installSessionLock(): void {
  if (lockInstalled) return
  lockInstalled = true
  type CreateFn = (...args: unknown[]) => Promise<ort.InferenceSession>
  type RunFn = (this: ort.InferenceSession, ...args: unknown[]) => Promise<ort.InferenceSession.ReturnType>
  const factory = ort.InferenceSession as unknown as { create: CreateFn; prototype: { run: RunFn } }
  const create = factory.create.bind(factory)
  const run = factory.prototype.run
  // Sessions can't exist before the runtime, so waiting for it here only delays creates.
  factory.create = (...args) => exclusive(() => ensureRuntime().then(() => create(...args)))
  factory.prototype.run = function (...args) {
    return exclusive(() => run.apply(this, args))
  }
}

// Before any transformers.js call can create a session.
configureOrt()

export { ort }
