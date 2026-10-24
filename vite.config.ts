import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

// COOP/COEP make the page cross-origin isolated, which multithreaded WASM
// (SharedArrayBuffer) needs. Production sends the same headers via public/_headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [preact()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web', '@huggingface/transformers'] },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
