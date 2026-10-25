import { wrap, type Remote } from 'comlink'
import type { PipelineApi } from './api'

let instance: Remote<PipelineApi> | null = null
let failure: ((message: string) => void) | null = null

/**
 * Called if the worker fails to start or crashes. Comlink can't reject calls that are already
 * waiting on a dead worker, so the UI has to be told directly.
 */
export function onPipelineFailure(cb: (message: string) => void): void {
  failure = cb
}

/** Spawn the pipeline worker and wrap it with Comlink. Returns the same instance on every call. */
export function getPipeline(): Remote<PipelineApi> {
  if (!instance) {
    const worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' })
    const fail = (message: string) => failure?.(`The drawing engine stopped: ${message}. Reload the page to try again.`)
    worker.addEventListener('error', (e) => fail(e.message || 'the worker failed to load'))
    worker.addEventListener('messageerror', () => fail('a message could not be read'))
    instance = wrap<PipelineApi>(worker)
  }
  return instance
}
