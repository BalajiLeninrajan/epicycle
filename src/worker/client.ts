import type { Remote } from 'comlink'
import type { PipelineApi } from './api'

/** Spawn the pipeline worker and wrap it with Comlink. Returns the same instance on every call. */
export function getPipeline(): Remote<PipelineApi> {
  throw new Error('not implemented')
}
