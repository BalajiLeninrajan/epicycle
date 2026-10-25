import { useSignal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { deriveParams } from '../pipeline/params'
import type { LineStyle, ModelId, ModelState, PipelineSettings } from '../pipeline/types'
import { Section, Segmented, Select, Slider, Toggle } from './controls'
import {
  cancelRecording,
  exportAs,
  loadModel,
  resetMask,
  setMaskEditing,
  undoSamPoint,
} from './controller'
import { ChevronIcon, DownloadIcon } from './icons'
import { logToInt, logToValue, valueToLog } from './logic'
import {
  error,
  exporting,
  hasDrawing,
  imageSize,
  maskBusy,
  maskEditing,
  maxCircles,
  models,
  pipelineSettings,
  recording,
  removeMode,
  render,
  result,
  running,
  samPoints,
  settings,
  showStrokes,
  source,
  time,
} from './state'

const STYLE_NAMES: Record<LineStyle, string> = { ai: 'AI lines', canny: 'Edges', stipple: 'Stipple' }

export function Panel() {
  const open = useSignal(true)
  const isImage = source.value === 'image'
  return (
    <aside class="panel fd-panel" data-density="compact" aria-label="Controls" data-open={open.value || undefined}>
      <header class="panel-header cn-between">
        <h2>Controls</h2>
        <button
          type="button"
          class="btn btn-ghost is-icon fd-sheet-toggle"
          aria-expanded={open.value}
          aria-controls="fd-panel-body"
          aria-label={open.value ? 'Collapse controls' : 'Expand controls'}
          onClick={() => (open.value = !open.value)}
        >
          <ChevronIcon />
        </button>
      </header>
      <div id="fd-panel-body" class="fd-panel-body scroll-well">
        <ErrorBanner />
        <RecordingBar />
        {/* A disabled fieldset disables every control inside it while recording. */}
        <fieldset class="fd-fieldset cn-divide" disabled={recording.value}>
          {isImage && <ModelStatus />}
          {isImage && <SubjectSection />}
          {isImage && <LinesSection />}
          <PathSection />
          <AnimationSection />
          <ExportSection />
          <Advanced isImage={isImage} />
        </fieldset>
      </div>
    </aside>
  )
}

function ErrorBanner() {
  const msg = error.value
  if (!msg) return null
  return (
    <div class="cn-px-16 cn-mt-16">
      <div class="banner cn-tone-red cn-between" role="alert">
        <span class="cn-grow">{msg}</span>
        <button type="button" class="btn-text" onClick={() => (error.value = null)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

function RecordingBar() {
  if (!recording.value) return null
  return (
    <div class="cn-stack cn-gap-8 cn-p-16" aria-live="polite">
      <div class="cn-row cn-between">
        <span class="cn-label">Recording one loop</span>
        <RecordingPercent />
      </div>
      <RecordingProgress />
      <button type="button" class="btn btn-secondary is-sm cn-fit" onClick={cancelRecording}>
        Cancel recording
      </button>
    </div>
  )
}

// Split out so the per-frame time updates re-render only these two.
function RecordingPercent() {
  return <span class="cn-meta">{Math.round(time.value * 100)}%</span>
}

function RecordingProgress() {
  return (
    <div
      class="progress-track"
      role="progressbar"
      aria-label="Recording progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(time.value * 100)}
    >
      <span style={{ width: `${time.value * 100}%` }} />
    </div>
  )
}

// ── Models ────────────────────────────────────────────────────────────────

const MODEL_NAMES: Record<ModelId, string> = {
  lineart: 'Line drawing model',
  segment: 'Subject model',
  sam: 'Mask editing model',
}

function ModelStatus() {
  const m = models.value
  const ids: ModelId[] = ['lineart', 'segment', 'sam']
  const shown = ids.filter((id) => id !== 'sam' || m.sam.status !== 'idle')
  // Once everything is ready the section collapses to one quiet line.
  if (shown.every((id) => m[id].status === 'ready')) {
    const gpu = shown.some((id) => {
      const s = m[id]
      return s.status === 'ready' && s.backend === 'webgpu'
    })
    return (
      <div class="cn-row cn-p-16">
        <span class="tag cn-tone-green">Models ready</span>
        <span class="cn-meta">{gpu ? 'Running on WebGPU' : 'Running on WebAssembly'}</span>
      </div>
    )
  }
  return (
    <Section title="Models">
      {shown.map((id) => (
        <ModelRow key={id} id={id} state={m[id]} />
      ))}
    </Section>
  )
}

function ModelRow(props: { id: ModelId; state: ModelState }) {
  const { id, state } = props
  const name = MODEL_NAMES[id]
  if (state.status === 'loading') {
    const pct = Math.round(state.progress * 100)
    return (
      <div class="cn-stack cn-gap-8">
        <div class="cn-row cn-between">
          <span class="cn-label">{name}</span>
          <span class="cn-meta">{pct > 0 ? `${pct}%` : 'Starting'}</span>
        </div>
        <div
          class="progress-track"
          role="progressbar"
          aria-label={`${name} download`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div class="cn-stack cn-gap-8">
        <div class="cn-row cn-between">
          <span class="cn-label">{name}</span>
          <button type="button" class="btn-text" onClick={() => loadModel(id)}>
            Retry
          </button>
        </div>
        <span class="tag cn-tone-red">{state.message}</span>
      </div>
    )
  }
  return (
    <div class="cn-row cn-between">
      <span class="cn-label">{name}</span>
      {state.status === 'ready' ? (
        <span class="tag cn-tone-green">Ready, {state.backend === 'webgpu' ? 'WebGPU' : 'WebAssembly'}</span>
      ) : (
        <span class="cn-meta">Waiting</span>
      )}
    </div>
  )
}

// ── Subject ───────────────────────────────────────────────────────────────

function SubjectSection() {
  const keep = settings.keepBackground.value
  const editing = maskEditing.value
  return (
    <Section title="Subject">
      <Segmented
        label="Draw"
        options={[
          { value: 'subject', label: 'Subject only' },
          { value: 'all', label: 'Keep background' },
        ]}
        value={keep ? 'all' : 'subject'}
        onChange={(v) => (settings.keepBackground.value = v === 'all')}
      />
      {!keep && !editing && <AutoMaskNote />}
      {editing ? (
        <MaskEditor />
      ) : (
        <div class="cn-cluster">
          <button type="button" class="btn btn-secondary is-sm" disabled={keep} onClick={() => setMaskEditing(true)}>
            Edit mask
          </button>
          {samPoints.value.length > 0 && (
            <button type="button" class="btn btn-ghost is-sm" disabled={keep} onClick={resetMask}>
              Reset mask
            </button>
          )}
        </div>
      )}
    </Section>
  )
}

function AutoMaskNote() {
  const seg = models.value.segment
  const res = result.value
  if (samPoints.value.length > 0) return <span class="cn-meta">Using your mask ({samPoints.value.length} clicks).</span>
  if (seg.status === 'loading') return <span class="cn-meta">Drawing the whole image until the subject model loads.</span>
  if (seg.status === 'error') return <span class="cn-meta">The subject model failed, so the whole image is drawn.</span>
  // While a run is in flight the shown result may predate the model; wait for the new one.
  if (res && !res.masked && seg.status === 'ready' && !running.value) return <span class="cn-meta">No subject found, so the whole image is drawn.</span>
  return null
}

function MaskEditor() {
  const pts = samPoints.value
  const remove = removeMode.value
  return (
    <div class="cn-stack cn-gap-12">
      <p class="cn-meta cn-m-0">
        Click the subject to add it. Shift-click, or turn on Remove, to cut a region out.
      </p>
      <div class="cn-cluster">
        <button
          type="button"
          class="btn btn-ghost is-sm"
          aria-pressed={remove}
          onClick={() => (removeMode.value = !remove)}
        >
          Remove
        </button>
        <button type="button" class="btn btn-ghost is-sm" disabled={pts.length === 0} onClick={undoSamPoint}>
          Undo
        </button>
        <button type="button" class="btn btn-ghost is-sm" disabled={pts.length === 0} onClick={resetMask}>
          Reset
        </button>
        <button type="button" class="btn btn-primary is-sm" onClick={() => setMaskEditing(false)}>
          Done
        </button>
      </div>
      <span class="cn-meta" aria-live="polite">
        {maskBusy.value
          ? 'Updating the mask'
          : pts.length === 0
            ? 'Showing the automatic mask'
            : `${pts.filter((p) => p.positive).length} added, ${pts.filter((p) => !p.positive).length} removed`}
      </span>
    </div>
  )
}

// ── Lines ─────────────────────────────────────────────────────────────────

function LinesSection() {
  return (
    <Section title="Lines">
      <DetailSlider />
      <UsedStyleNote />
    </Section>
  )
}

function DetailSlider() {
  const d = settings.detail.value
  return (
    <Slider
      label="Detail"
      min={0}
      max={100}
      value={Math.round(d * 100)}
      display={`${Math.round(d * 100)}%`}
      onInput={(v) => (settings.detail.value = v / 100)}
    />
  )
}

function UsedStyleNote() {
  const res = result.value
  const chosen = settings.lineStyle.value
  if (!res || res.usedLineStyle === chosen) return null
  const lineart = models.value.lineart
  const why =
    lineart.status === 'loading'
      ? `while the line drawing model loads (${Math.round(lineart.progress * 100)}%)`
      : lineart.status === 'error'
        ? 'because the line drawing model failed to load'
        : 'until the line drawing model is ready'
  return (
    <div class="banner cn-tone-peach" role="status">
      Drawn with {STYLE_NAMES[res.usedLineStyle].toLowerCase()} {why}.
    </div>
  )
}

// ── Path ──────────────────────────────────────────────────────────────────

function PathSection() {
  return (
    <Section title="Path">
      <Toggle
        label="Hide connecting lines"
        checked={render.hideJumps.value}
        onChange={(v) => (render.hideJumps.value = v)}
      />
    </Section>
  )
}

// ── Animation ─────────────────────────────────────────────────────────────

const DURATION_MIN = 3
const DURATION_MAX = 120

function AnimationSection() {
  return (
    <Section title="Animation">
      <CirclesSlider />
      <DurationSlider />
    </Section>
  )
}

function CirclesSlider() {
  const max = maxCircles.value
  const k = Math.min(render.circles.value, max)
  return (
    <Slider
      label="Circles"
      min={0}
      max={1000}
      value={valueToLog(k, 1, max)}
      display={`${k} of ${max}`}
      onInput={(pos) => (render.circles.value = logToInt(pos, 1, max))}
    />
  )
}

function DurationSlider() {
  const sec = render.durationSec.value
  return (
    <Slider
      label="Loop duration"
      min={0}
      max={1000}
      value={valueToLog(sec, DURATION_MIN, DURATION_MAX)}
      display={`${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`}
      onInput={(pos) => {
        const v = logToValue(pos, DURATION_MIN, DURATION_MAX)
        render.durationSec.value = v < 10 ? Math.round(v * 10) / 10 : Math.round(v)
      }}
    />
  )
}

// ── Export ────────────────────────────────────────────────────────────────

function ExportSection() {
  const can = hasDrawing.value
  const busy = exporting.value
  const webm = typeof MediaRecorder !== 'undefined'
  return (
    <Section title="Export">
      <div class="cn-cluster">
        <button type="button" class="btn btn-secondary is-sm" disabled={!can || busy !== null} onClick={() => void exportAs('png')}>
          <DownloadIcon />
          PNG
        </button>
        <button
          type="button"
          class="btn btn-secondary is-sm"
          disabled={!can || busy !== null || !webm}
          onClick={() => void exportAs('webm')}
        >
          <DownloadIcon />
          WebM
        </button>
        <button type="button" class="btn btn-secondary is-sm" disabled={!can || busy !== null} onClick={() => void exportAs('svg')}>
          <DownloadIcon />
          SVG
        </button>
      </div>
      <span class="cn-meta">
        {webm ? 'WebM records one full loop in real time.' : 'This browser cannot record WebM.'}
      </span>
    </Section>
  )
}

// ── Advanced ──────────────────────────────────────────────────────────────

function Advanced(props: { isImage: boolean }) {
  const open = useSignal(false)
  return (
    <div class="cn-p-16">
      <div class="accordion" data-open={open.value || undefined}>
        <label>
          <input type="checkbox" checked={open.value} onChange={(e) => (open.value = e.currentTarget.checked)} />
          <b>Advanced</b>
        </label>
        <div class="fold">
          <div class="cn-stack cn-gap-24">
            {props.isImage && <AdvancedLines />}
            <AdvancedPath />
            <AdvancedAnimation />
          </div>
        </div>
      </div>
    </div>
  )
}

function Group(props: { title: string; children: ComponentChildren }) {
  return (
    <div class="cn-stack cn-gap-16" role="group" aria-label={props.title}>
      <span class="cn-microlabel">{props.title}</span>
      {props.children}
    </div>
  )
}

function AdvancedLines() {
  return (
    <Group title="Lines">
      <LineStyleControl />
      <StippleCount />
      <Toggle
        label="Add the subject outline"
        checked={settings.includeSilhouette.value}
        disabled={settings.keepBackground.value}
        onChange={(v) => (settings.includeSilhouette.value = v)}
      />
      <Overrides />
      <Toggle label="Show strokes" checked={showStrokes.value} onChange={(v) => (showStrokes.value = v)} />
    </Group>
  )
}

function LineStyleControl() {
  return (
    <Segmented<LineStyle>
      label="Style"
      options={[
        { value: 'ai', label: STYLE_NAMES.ai },
        { value: 'canny', label: STYLE_NAMES.canny },
        { value: 'stipple', label: STYLE_NAMES.stipple },
      ]}
      value={settings.lineStyle.value}
      onChange={(v) => (settings.lineStyle.value = v)}
    />
  )
}

function StippleCount() {
  if (settings.lineStyle.value !== 'stipple') return null
  const n = settings.stippleCount.value
  return (
    <Slider
      label="Dots"
      min={0}
      max={1000}
      value={valueToLog(n, 200, 20000)}
      display={n.toLocaleString()}
      onInput={(pos) => (settings.stippleCount.value = Math.round(logToValue(pos, 200, 20000) / 50) * 50)}
    />
  )
}

type OverrideKey = 'lineThreshold' | 'minStrokeLength' | 'simplifyEpsilon'

const OVERRIDES: { name: OverrideKey; label: string; min: number; max: number; step: number; unit: string; digits: number }[] = [
  { name: 'lineThreshold', label: 'Ink threshold', min: 0.05, max: 0.95, step: 0.01, unit: '', digits: 2 },
  { name: 'minStrokeLength', label: 'Shortest stroke', min: 2, max: 120, step: 1, unit: ' px', digits: 0 },
  { name: 'simplifyEpsilon', label: 'Simplify', min: 0, max: 5, step: 0.1, unit: ' px', digits: 1 },
]

function Overrides() {
  if (settings.lineStyle.value === 'stipple') return null
  return (
    <>
      {OVERRIDES.map((o) => (
        <OverrideSlider key={o.name} {...o} />
      ))}
    </>
  )
}

function OverrideSlider(props: (typeof OVERRIDES)[number]) {
  const sig = settings[props.name]
  const override = sig.value
  const size = imageSize.value ?? { width: 0, height: 0 }
  // The auto value is what the pipeline derives from the detail slider.
  const auto: PipelineSettings = { ...pipelineSettings.value, [props.name]: undefined }
  const value = override ?? deriveParams(auto, size.width, size.height)[props.name]
  const shown = Math.min(props.max, Math.max(props.min, value))
  const display = `${shown.toFixed(props.digits)}${props.unit}${override === undefined ? ' (auto)' : ''}`
  if (props.name === 'lineThreshold' && settings.lineStyle.value !== 'ai') return null
  return (
    <Slider
      label={props.label}
      min={props.min}
      max={props.max}
      step={props.step}
      value={shown}
      display={display}
      onInput={(v) => (sig.value = v)}
      extra={
        override !== undefined && (
          <button
            type="button"
            class="btn-text"
            aria-label={`Reset ${props.label.toLowerCase()} to auto`}
            onClick={() => (sig.value = undefined)}
          >
            Auto
          </button>
        )
      }
    />
  )
}

function AdvancedPath() {
  return (
    <Group title="Path">
      <Select<PipelineSettings['sampleCount']>
        label="Samples"
        options={[
          { value: 2048, label: '2048 points' },
          { value: 4096, label: '4096 points' },
          { value: 8192, label: '8192 points' },
        ]}
        value={settings.sampleCount.value}
        onChange={(v) => (settings.sampleCount.value = v)}
      />
    </Group>
  )
}

function AdvancedAnimation() {
  return (
    <Group title="Animation">
      <Toggle label="Show circles" checked={render.showCircles.value} onChange={(v) => (render.showCircles.value = v)} />
      <Toggle label="Show arrows" checked={render.showArrows.value} onChange={(v) => (render.showArrows.value = v)} />
      <Toggle label="Show trail" checked={render.showTrail.value} onChange={(v) => (render.showTrail.value = v)} />
      <Segmented<'full' | 'fade'>
        label="Trail style"
        options={[
          { value: 'full', label: 'Full' },
          { value: 'fade', label: 'Fading' },
        ]}
        value={render.trailMode.value}
        disabled={!render.showTrail.value}
        onChange={(v) => (render.trailMode.value = v)}
      />
      <Toggle label="Follow the tip" checked={render.followTip.value} onChange={(v) => (render.followTip.value = v)} />
      <ZoomSlider />
      <LineWidthSlider />
    </Group>
  )
}

function ZoomSlider() {
  const z = render.followZoom.value
  return (
    <Slider
      label="Follow zoom"
      min={0}
      max={1000}
      value={valueToLog(z, 1.5, 40)}
      display={`${z.toFixed(1)}x`}
      disabled={!render.followTip.value}
      onInput={(pos) => (render.followZoom.value = Math.round(logToValue(pos, 1.5, 40) * 10) / 10)}
    />
  )
}

function LineWidthSlider() {
  const w = render.lineWidth.value
  return (
    <Slider
      label="Line width"
      min={0.5}
      max={8}
      step={0.5}
      value={w}
      display={`${w.toFixed(1)} px`}
      onInput={(v) => (render.lineWidth.value = v)}
    />
  )
}
