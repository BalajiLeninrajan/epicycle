# epicycle

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/BalajiLeninrajan/epicycle/blob/main/LICENSE)

`epicycle` turns any image into one continuous line, then draws that line with a chain of spinning circles, like the drawings in 3Blue1Brown's [But what is a Fourier series?](https://www.youtube.com/watch?v=r6sGWTCMz2k). Ptolemy was right about something.

Everything runs in your browser. Photos never leave the device: the models download once, get cached, and run on WebGPU, or on WebAssembly when there is no GPU.

## How an image becomes circles

| Step | What happens |
| --- | --- |
| Subject | [MODNet](https://github.com/ZHKKKe/MODNet) masks out the background of portraits. For anything else, click the subject and [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) selects it; shift-click cuts a region out. |
| Lines | [Informative Drawings](https://github.com/carolineec/informative-drawings) redraws the photo as line art, and only the lines inside the mask are kept. The mask outline is added as a silhouette. Canny edges stand in while the model downloads. |
| Strokes | The lines are thinned to 1px (Zhang-Suen), traced into polylines, and short fragments are dropped. |
| One line | The strokes are joined into a single closed path: nearest neighbour, then 2-opt and Or-opt, with each stroke free to run either way. The connecting jumps are flagged and drawn fainter. |
| Circles | The path is resampled to 8192 evenly spaced points (by default) and run through an FFT. Each coefficient is a circle; the biggest go first, and the tip of the chain traces the path. |

SVG uploads skip straight to the "One line" step. Stipple mode replaces the line steps with weighted Voronoi stippling and a TSP tour through the dots.

## Controls

- **Detail** sets the line threshold, minimum stroke length and simplification together. Advanced overrides each one.
- **Circles** goes from 1 up to the sample count (8192 by default) on a log scale. Around 1000 is enough for a face.
- **Trail style**: the line fades with age over one loop, like the video, or the finished drawing stays up.
- **Follow the tip** zooms in on the end of the chain.
- **Export** saves a PNG of the finished drawing, a WebM of one loop, or the single-line path as SVG (handy for pen plotters).

Paste an image with Ctrl+V or drop it on the page.

## Models

All three come from Hugging Face on first use and stay in the browser's Cache API. The ONNX Runtime wasm build (27 MB) comes from jsDelivr, since it is over Cloudflare's 25 MiB limit for a static asset.

| Model | Download | Peak memory (CPU) | License |
| --- | --- | --- | --- |
| [Informative Drawings, line art](https://huggingface.co/rocca/informative-drawings-line-art-onnx) | 17 MB | ~320 MB | MIT |
| [MODNet](https://huggingface.co/Xenova/modnet) | 26 MB | ~270 MB | Apache-2.0 |
| [MobileSAM](https://huggingface.co/Acly/MobileSAM) | 44 MB | ~360 MB | Apache-2.0 (weights), MIT (ONNX export) |

BiRefNet and SlimSAM were tried first. Both are better on paper, and both got the browser OOM-killed on an 8 GB laptop.

## Development

```console
pnpm install
pnpm dev
```

```console
pnpm test        # vitest
pnpm typecheck
pnpm build
```

The dev server sends `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers, which multithreaded WebAssembly needs. Production gets the same headers from `public/_headers`.

## Deploy

It is a static site on Cloudflare Workers:

```console
pnpm deploy
```

## Limits

- MODNet only knows people. Other subjects need a few clicks.
- Busy photos give busy drawings. The line-art model draws texture as well as edges, so a detailed background or patterned clothing turns into a lot of short strokes.
- Some connecting jumps are long. They draw at a quarter of the line's opacity, but they still show.
- WebM recording happens in real time, one full loop.
- Tested on Chromium with WebGPU on an Intel GPU. Other GPUs and the WebAssembly fallback haven't been tested end to end in a browser.
