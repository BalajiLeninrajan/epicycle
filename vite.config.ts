import { defineConfig } from 'vitest/config'
import { defaultClientConditions } from 'vite'
import preact from '@preact/preset-vite'

// COOP/COEP make the page cross-origin isolated, which multithreaded WASM
// (SharedArrayBuffer) needs. Production sends the same headers via public/_headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [preact()],
  // ORT's wasm runtime (~27MB) is over the 25 MiB Workers static asset limit, so don't
  // emit it; src/ml/backend.ts loads it from jsDelivr instead.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: {
    // lightningcss rejects catppuccin-neu's ::picker(select):popover-open selector.
    cssMinify: 'esbuild',
    // posthog-js in its own chunk keeps the entry small and stays cached across deploys.
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'posthog', test: /node_modules[\\/]posthog-js/ }] } } },
  },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // Two workers keep test runs light on low-memory machines.
  test: { environment: 'node', include: ['src/**/*.test.ts'], maxWorkers: 2 },
})
