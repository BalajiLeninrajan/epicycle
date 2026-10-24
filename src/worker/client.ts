import { wrap, type Remote } from 'comlink'
import type { PipelineApi } from './api'

let instance: Remote<PipelineApi> | null = null

/** Spawn the pipeline worker and wrap it with Comlink. Returns the same instance on every call. */
export function getPipeline(): Remote<PipelineApi> {
  if (!instance) {
    const worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' })
    instance = wrap<PipelineApi>(worker)
  }
  return instance
}
