// Birthday page: the drawing, its circles, the formula and a zoom. Nothing else.
import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { computeCoeffs } from '../fourier/epicycles'
import { resample } from '../pipeline/resample'
import { EpicycleRenderer } from '../render/epicycles'
import drawing from './drawing.json'
import '../styles.css'
import './bday.css'

const SAMPLES = 8192
const CIRCLES = 1500
const LOOP_SEC = 30
/** The trail lasts 1.75 loops, so the part about to be redrawn is still at about a quarter strength. */
const FADE_LOOPS = 1.75
const MAX_ZOOM = 80
/** By this zoom the camera is centred on the tip; below it the view slides there from the drawing's centre. */
const FOLLOW_FULL_AT = 2.5
const SLIDER_STEPS = 1000
/** Camera cap and dead zone for the smooth follow (CSS px per second, fraction of the short side). */
const CAM_MAX_SPEED = 700
const CAM_DEAD_ZONE = 0.12

const sampled = resample({ points: Float32Array.from(drawing.points), jump: Uint8Array.from(drawing.jump) }, SAMPLES)
const coeffs = computeCoeffs(sampled)

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(1, z))
const followFor = (z: number) => Math.min(1, Math.log(z) / Math.log(FOLLOW_FULL_AT))

// The series the circles draw, and how each coefficient comes from the path.
const SERIES =
  '<math display="block"><mi>f</mi><mo stretchy="false">(</mo><mi>t</mi><mo stretchy="false">)</mo><mo>=</mo>' +
  '<munder><mo>∑</mo><mi>n</mi></munder><msub><mi>c</mi><mi>n</mi></msub>' +
  '<msup><mi>e</mi><mrow><mi>n</mi><mo>·</mo><mn>2</mn><mi>π</mi><mi>i</mi><mi>t</mi></mrow></msup></math>'
const COEFFICIENT =
  '<math display="block"><msub><mi>c</mi><mi>n</mi></msub><mo>=</mo>' +
  '<msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup><mi>f</mi><mo stretchy="false">(</mo><mi>t</mi><mo stretchy="false">)</mo>' +
  '<msup><mi>e</mi><mrow><mo>−</mo><mi>n</mi><mo>·</mo><mn>2</mn><mi>π</mi><mi>i</mi><mi>t</mi></mrow></msup>' +
  '<mspace width="0.2em"/><mi>d</mi><mi>t</mi></math>'

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<EpicycleRenderer | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [zoom, setZoom] = useState(1)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const d = dialogRef.current
    if (d && !d.open) d.showModal()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const r = new EpicycleRenderer(canvas)
    r.setOptions({
      circles: CIRCLES,
      durationSec: LOOP_SEC,
      trailMode: 'fade',
      fadeFraction: FADE_LOOPS,
      showCircles: true,
      showArrows: true,
      followTip: true,
      followZoom: 1,
      followAmount: 0,
      camMaxSpeed: CAM_MAX_SPEED,
      camDeadZone: CAM_DEAD_ZONE,
      playing: false,
    })
    r.setData(coeffs, sampled)
    rendererRef.current = r
    return () => r.dispose()
  }, [])

  useEffect(() => {
    // Time slows as you zoom in, so the tip crosses the screen at the same speed at any zoom
    // and the capped camera can keep it in view.
    rendererRef.current?.setOptions({ followZoom: zoom, followAmount: followFor(zoom), timeScale: 1 / zoom })
  }, [zoom])

  useEffect(() => {
    if (started) rendererRef.current?.setOptions({ playing: true })
  }, [started])

  // Wheel and pinch zoom on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setZoom((z) => clampZoom(z * Math.exp(-e.deltaY * 0.002)))
    }
    const pointers = new Map<number, { x: number; y: number }>()
    let pinch = 0
    const spread = () => {
      const [a, b] = [...pointers.values()]
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
    }
    const onDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) pinch = spread()
    }
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size !== 2 || pinch === 0) return
      const d = spread()
      if (d > 0) setZoom((z) => clampZoom((z * d) / pinch))
      pinch = d
    }
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      pinch = 0
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [])

  const slider = Math.round((Math.log(zoom) / Math.log(MAX_ZOOM)) * SLIDER_STEPS)
  return (
    <main class="bd-stage">
      <canvas ref={canvasRef} class="bd-canvas" role="img" aria-label="A drawing made by 1500 rotating circles" />
      <div class="fd-formula bd-formula cn-r-card" aria-label="Fourier series formula">
        <div dangerouslySetInnerHTML={{ __html: SERIES }} />
        <div dangerouslySetInnerHTML={{ __html: COEFFICIENT }} />
        <span class="cn-meta">{CIRCLES} circles, largest |c<sub>n</sub>| first</span>
      </div>
      <dialog ref={dialogRef} class="modal bd-intro" onClose={() => setStarted(true)} aria-labelledby="bd-title">
        <h1 id="bd-title">அப்பா,</h1>
        <p>This is a complex Fourier series.</p>
        <div class="bd-math">
          <div dangerouslySetInnerHTML={{ __html: SERIES }} />
          <div dangerouslySetInnerHTML={{ __html: COEFFICIENT }} />
        </div>
        <p>I can only understand it because of the education you worked so hard to give me.</p>
        <form method="dialog" class="bd-intro-actions">
          <button type="submit" class="btn btn-primary" autofocus>
            Play
          </button>
        </form>
      </dialog>
      <label class="bd-zoom cn-r-card">
        <span class="cn-meta">Zoom</span>
        <input
          type="range"
          class="fd-range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={slider}
          aria-valuetext={`${zoom.toFixed(1)}×`}
          onInput={(e) => setZoom(clampZoom(MAX_ZOOM ** (Number(e.currentTarget.value) / SLIDER_STEPS)))}
        />
        <span class="cn-meta bd-zoom-value">{zoom < 9.95 ? zoom.toFixed(1) : Math.round(zoom)}×</span>
        {zoom >= 1.05 && <span class="cn-meta bd-zoom-value">{zoom < 9.95 ? (1 / zoom).toFixed(2) : `1/${Math.round(zoom)}`} speed</span>}
      </label>
    </main>
  )
}

render(<App />, document.getElementById('app')!)
