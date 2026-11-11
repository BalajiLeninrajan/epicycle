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
/** Line width in CSS px: thin, and thinner still on phones where the drawing is small. */
const isSmall = () => Math.min(innerWidth, innerHeight) < 640
const lineWidthFor = () => (isSmall() ? 0.5 : 1)
/** Arrow width in CSS px; the renderer's default is 1.25. */
const arrowWidthFor = () => (isSmall() ? 0.5 : 1.25)

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
  const introRef = useRef<HTMLDivElement>(null)
  const formulaRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  /** intro: the note is up. leaving: the equations are flying to the corner. started: playing. */
  const [phase, setPhase] = useState<'intro' | 'leaving' | 'started'>('intro')
  const started = phase === 'started'

  /** Fly each equation from the note to its place in the formula box, then start drawing. */
  const play = () => {
    if (phase !== 'intro') return
    const from = [...(introRef.current?.querySelectorAll<HTMLElement>('.bd-eq') ?? [])]
    const to = [...(formulaRef.current?.querySelectorAll<HTMLElement>('.bd-eq') ?? [])]
    setPhase('leaving')
    if (from.length !== to.length || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhase('started')
      return
    }
    const clones = from.map((el, i) => {
      const r0 = el.getBoundingClientRect()
      const r1 = to[i].getBoundingClientRect()
      const cs = getComputedStyle(el)
      const clone = el.cloneNode(true) as HTMLElement
      clone.classList.add('bd-flying')
      Object.assign(clone.style, {
        left: `${r0.left}px`,
        top: `${r0.top}px`,
        width: `${r0.width}px`,
        fontSize: cs.fontSize,
      })
      document.body.appendChild(clone)
      el.style.visibility = 'hidden'
      const anim = clone.animate(
        [
          { transform: 'translate(0, 0) scale(1)' },
          { transform: `translate(${r1.left - r0.left}px, ${r1.top - r0.top}px) scale(${r1.width / r0.width})` },
        ],
        { duration: 1200, delay: 250, easing: 'cubic-bezier(0.65, 0, 0.25, 1)', fill: 'forwards' },
      )
      return { clone, anim }
    })
    void Promise.all(clones.map((c) => c.anim.finished)).then(() => {
      setPhase('started')
      // Let the real equations show before the copies go, so nothing blinks.
      requestAnimationFrame(() => requestAnimationFrame(() => clones.forEach((c) => c.clone.remove())))
    })
  }

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
      lineWidth: lineWidthFor(),
      arrowWidth: arrowWidthFor(),
      // Zoomed in, circles bigger than half the screen fade out, so the view isn't all giant arcs.
      hideAbove: 0.5,
      playing: false,
    })
    r.setData(coeffs, sampled)
    rendererRef.current = r
    const onResize = () => r.setOptions({ lineWidth: lineWidthFor(), arrowWidth: arrowWidthFor() })
    addEventListener('resize', onResize)
    return () => {
      removeEventListener('resize', onResize)
      r.dispose()
    }
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
      <canvas ref={canvasRef} class="bd-canvas" role="img" aria-label="A drawing made by rotating circles" />
      <div
        ref={formulaRef}
        class={`fd-formula bd-formula cn-r-card bd-fade${phase === 'intro' ? ' is-hidden' : ''}`}
        aria-label="Fourier series formula"
      >
        <div class={`bd-eq${started ? '' : ' is-waiting'}`} dangerouslySetInnerHTML={{ __html: SERIES }} />
        <div class={`bd-eq${started ? '' : ' is-waiting'}`} dangerouslySetInnerHTML={{ __html: COEFFICIENT }} />
      </div>
      {!started && (
        <>
          <div class={`bd-backdrop${phase === 'leaving' ? ' is-leaving' : ''}`} />
          <div
            ref={introRef}
            class={`modal bd-intro${phase === 'leaving' ? ' is-leaving' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label="A note"
          >
            <p>This is a complex Fourier series.</p>
            <div class="bd-math">
              <div class="bd-eq" dangerouslySetInnerHTML={{ __html: SERIES }} />
              <div class="bd-eq" dangerouslySetInnerHTML={{ __html: COEFFICIENT }} />
            </div>
            <p>I can only understand it because of the education you worked so hard to give me. Thank you, <span class="bd-ta">அப்பா</span>.</p>
            <div class="bd-intro-actions">
              <button type="button" class="btn btn-primary" autofocus onClick={play}>
                Play
              </button>
            </div>
          </div>
        </>
      )}
      <label class={`bd-zoom cn-r-card bd-fade${started ? '' : ' is-hidden'}`}>
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
