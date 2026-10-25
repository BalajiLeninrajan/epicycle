import { computed, useSignal, useSignalEffect } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import {
  addSamPoint,
  attachStage,
  beginScrub,
  endScrub,
  openFile,
  pasteFromClipboard,
  scrubTo,
} from './controller'
import { ClipboardIcon, PauseIcon, PlayIcon, UploadIcon } from './icons'
import { formatClock } from './logic'
import { drawOverlay, imageFit } from './overlay'
import {
  error,
  exporting,
  hasDrawing,
  maskBusy,
  maskEditing,
  maskOutline,
  models,
  preview,
  removeMode,
  render,
  result,
  running,
  samPoints,
  showFormula,
  showStrokes,
  source,
  time,
} from './state'

const ACCEPT = 'image/*,.svg,image/svg+xml'

const SCRUB_STEPS = 1000
const scrubPos = computed(() => Math.round(time.value * SCRUB_STEPS))
const clock = computed(
  () => `${formatClock(time.value * render.durationSec.value)} / ${formatClock(render.durationSec.value)}`,
)

/** Hidden file input shared by every "choose a file" button. */
let fileInput: HTMLInputElement | null = null
export function pickFile(): void {
  fileInput?.click()
}

export function FileInput() {
  return (
    <input
      ref={(el) => {
        fileInput = el
      }}
      type="file"
      accept={ACCEPT}
      class="cn-hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const file = e.currentTarget.files?.[0]
        e.currentTarget.value = ''
        if (file) void openFile(file)
      }}
    />
  )
}

export function Stage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const size = useSignal({ w: 0, h: 0, dpr: 1 })
  const dragging = useSignal(false)

  useEffect(() => {
    const canvas = canvasRef.current
    return canvas ? attachStage(canvas) : undefined
  }, [])

  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(el.clientWidth * dpr)
      const h = Math.round(el.clientHeight * dpr)
      if (w !== el.width || h !== el.height) {
        el.width = w
        el.height = h
      }
      size.value = { w, h, dpr }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useSignalEffect(() => {
    const el = overlayRef.current
    const { dpr } = size.value
    if (!el) return
    const res = result.value
    drawOverlay(
      el,
      {
        editing: maskEditing.value,
        image: preview.value,
        outline: maskOutline.value,
        points: samPoints.value,
        // The preview only lines up with the resting view, not while following the tip.
        strokes: showStrokes.value && !render.followTip.value && res ? res.strokes : null,
        result: res,
      },
      dpr,
    )
  })

  const onOverlayClick = (e: MouseEvent) => {
    const el = overlayRef.current
    const img = preview.peek()
    if (!el || !img || !maskEditing.peek()) return
    const rect = el.getBoundingClientRect()
    const fit = imageFit(img, rect.width, rect.height)
    if (fit.s <= 0) return
    const x = (e.clientX - rect.left - fit.x) / (img.width * fit.s)
    const y = (e.clientY - rect.top - fit.y) / (img.height * fit.s)
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    addSamPoint(x, y, !(e.shiftKey || removeMode.peek()))
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    dragging.value = false
    const file = e.dataTransfer?.files[0]
    if (file) void openFile(file)
  }

  const empty = source.value === 'none'
  const editing = maskEditing.value

  return (
    <div
      class="fd-stage-col"
      onDragOver={(e) => {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        dragging.value = true
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) dragging.value = false
      }}
      onDrop={onDrop}
    >
      <div class="fd-stage">
        <canvas ref={canvasRef} class="fd-canvas" aria-label="Epicycle animation" role="img" />
        <canvas
          ref={overlayRef}
          class={editing ? 'fd-canvas fd-overlay is-editing' : 'fd-canvas fd-overlay'}
          aria-hidden={!editing}
          aria-label={editing ? 'Photo for mask editing. Click to add the subject, shift-click to remove.' : undefined}
          role={editing ? 'img' : undefined}
          onClick={onOverlayClick}
        />
        {empty ? <DropZone dragging={dragging.value} /> : <StageStatus />}
        {!empty && !editing && hasDrawing.value && showFormula.value && <Formula />}
        {!empty && dragging.value && <div class="fd-drop-hint cn-engaged cn-r-card" aria-hidden="true" />}
      </div>
      <Transport />
    </div>
  )
}

// The series the circles draw, and how each coefficient comes from the path (as in the
// 3Blue1Brown video). Static markup, so innerHTML carries no user input.
const SERIES =
  '<math display="block"><mi>f</mi><mo stretchy="false">(</mo><mi>t</mi><mo stretchy="false">)</mo><mo>=</mo>' +
  '<munder><mo>∑</mo><mi>n</mi></munder><msub><mi>c</mi><mi>n</mi></msub>' +
  '<msup><mi>e</mi><mrow><mi>n</mi><mo>·</mo><mn>2</mn><mi>π</mi><mi>i</mi><mi>t</mi></mrow></msup></math>'
const COEFFICIENT =
  '<math display="block"><msub><mi>c</mi><mi>n</mi></msub><mo>=</mo>' +
  '<msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup><mi>f</mi><mo stretchy="false">(</mo><mi>t</mi><mo stretchy="false">)</mo>' +
  '<msup><mi>e</mi><mrow><mo>−</mo><mi>n</mi><mo>·</mo><mn>2</mn><mi>π</mi><mi>i</mi><mi>t</mi></mrow></msup>' +
  '<mspace width="0.2em"/><mi>d</mi><mi>t</mi></math>'

function Formula() {
  const k = Math.min(render.circles.value, result.value?.coeffs.n ?? 0)
  return (
    <div class="fd-formula cn-r-card" aria-label="Fourier series formula">
      <div dangerouslySetInnerHTML={{ __html: SERIES }} />
      <div dangerouslySetInnerHTML={{ __html: COEFFICIENT }} />
      <span class="cn-meta">
        {k} {k === 1 ? 'circle' : 'circles'}, largest |c<sub>n</sub>| first
      </span>
    </div>
  )
}

function DropZone(props: { dragging: boolean }) {
  return (
    <div class={props.dragging ? 'fd-dropzone cn-edge-dashed cn-r-card cn-engaged' : 'fd-dropzone cn-edge-dashed cn-r-card'}>
      <div class="empty-state is-fill">
        <UploadIcon />
        <strong>Drop an image or SVG</strong>
        <span>A photo becomes one continuous line, then a chain of spinning circles draws it.</span>
        <div class="cn-cluster cn-center cn-mt-8">
          <button type="button" class="btn btn-primary" onClick={pickFile}>
            Choose a file
          </button>
          <button type="button" class="btn btn-secondary" onClick={() => void pasteFromClipboard()}>
            <ClipboardIcon />
            Paste
          </button>
        </div>
        <span>JPEG, PNG, WebP or SVG. Nothing leaves your device.</span>
        <DropError />
      </div>
    </div>
  )
}

function DropError() {
  const msg = error.value
  if (!msg) return null
  return (
    <div class="banner cn-tone-red cn-mt-8" role="alert">
      {msg}
    </div>
  )
}

function StageStatus() {
  const editing = maskEditing.value
  const samLoading = models.value.sam.status === 'loading'
  let text: string | null = null
  if (editing && maskBusy.value) text = samLoading ? 'Loading the mask model' : 'Updating mask'
  else if (running.value) text = 'Tracing'
  else if (exporting.value === 'webm') text = 'Recording'
  return (
    <div class="fd-stage-status cn-row cn-gap-8" aria-live="polite">
      {text && (
        <span class="chip">
          <span class="spinner" aria-hidden="true" />
          {text}
        </span>
      )}
      {result.value && !hasDrawing.value && !running.value && !editing && (
        <span class="tag cn-tone-peach">No lines found. Try more detail or keep the background.</span>
      )}
    </div>
  )
}

function Transport() {
  if (!hasDrawing.value) return null
  const playing = render.playing.value
  const disabled = exporting.value === 'webm'
  return (
    <div class="cn-row cn-gap-12 cn-py-8">
      <button
        type="button"
        class="btn btn-secondary is-icon"
        aria-label={playing ? 'Pause' : 'Play'}
        data-tip={playing ? 'Pause' : 'Play'}
        disabled={disabled}
        onClick={() => (render.playing.value = !playing)}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <input
        type="range"
        class="fd-range cn-grow"
        min={0}
        max={SCRUB_STEPS - 1}
        step={1}
        value={scrubPos}
        disabled={disabled}
        aria-label="Timeline"
        aria-valuetext={clock}
        onPointerDown={beginScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onBlur={endScrub}
        onInput={(e) => scrubTo(Number(e.currentTarget.value) / SCRUB_STEPS)}
      />
      <span class="cn-meta cn-nowrap">{clock}</span>
    </div>
  )
}
