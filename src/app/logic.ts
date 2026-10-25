// Pure UI helpers, kept DOM-free so they run in node tests.

/** Slider positions run 0..LOG_STEPS. */
export const LOG_STEPS = 1000

/** Slider position (0..steps) to a value on a log scale between min and max (both > 0). */
export function logToValue(pos: number, min: number, max: number, steps = LOG_STEPS): number {
  if (!(max > min) || !(min > 0)) return min
  const t = Math.min(1, Math.max(0, (Number.isFinite(pos) ? pos : 0) / steps))
  return Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)))
}

/** Inverse of logToValue: value to the nearest slider position. */
export function valueToLog(value: number, min: number, max: number, steps = LOG_STEPS): number {
  if (!(max > min) || !(min > 0)) return 0
  const v = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
  return Math.round(((Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min))) * steps)
}

/** Log slider over integers, e.g. circle count 1..N. */
export function logToInt(pos: number, min: number, max: number, steps = LOG_STEPS): number {
  return Math.min(max, Math.max(min, Math.round(logToValue(pos, min, max, steps))))
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

export interface LatestRunner {
  /** Run after `delay` ms of quiet. Each call restarts the wait. */
  schedule(): void
  /** Run now, cancelling a pending scheduled run. */
  flush(): void
  /** Forget pending and in-flight runs; their results are dropped. */
  cancel(): void
}

export interface LatestRunnerOptions<R> {
  delay: number
  onResult(result: R): void
  onError(err: unknown): void
  /** Called with true when a run starts and false when the latest run settles or is cancelled. */
  onBusy?(busy: boolean): void
  timers?: Timers
}

/**
 * Debounced async runner where only the newest run's outcome is applied.
 * Older runs may still finish, but their result or error is dropped.
 */
export function latestRunner<R>(task: () => Promise<R>, opts: LatestRunnerOptions<R>): LatestRunner {
  const timers = opts.timers ?? realTimers
  let seq = 0
  let timer: unknown = null

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }

  const start = () => {
    clear()
    const id = ++seq
    opts.onBusy?.(true)
    let p: Promise<R>
    try {
      p = task()
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then(
      (r) => {
        if (id !== seq) return
        opts.onBusy?.(false)
        opts.onResult(r)
      },
      (err: unknown) => {
        if (id !== seq) return
        opts.onBusy?.(false)
        opts.onError(err)
      },
    )
  }

  return {
    schedule() {
      clear()
      timer = timers.setTimeout(start, opts.delay)
    },
    flush: start,
    cancel() {
      clear()
      seq++
      opts.onBusy?.(false)
    },
  }
}

/** Message text for anything thrown across Comlink. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  return 'Something went wrong'
}

/** File name without its extension, safe for a download name. */
export function baseName(name: string): string {
  const stem = name.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
  const safe = stem.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'drawing'
}

/** True for an SVG by MIME type or extension. */
export function isSvgFile(type: string, name: string): boolean {
  return type === 'image/svg+xml' || /\.svg$/i.test(name)
}

/** Seconds as m:ss. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Fit a w x h rectangle inside a W x H box, centered, leaving `margin` (fraction of the short side) free. */
export function containFit(
  w: number,
  h: number,
  boxW: number,
  boxH: number,
  margin = 0.04,
): { x: number; y: number; s: number } {
  if (!(w > 0) || !(h > 0) || !(boxW > 0) || !(boxH > 0)) return { x: 0, y: 0, s: 0 }
  const pad = Math.min(boxW, boxH) * margin
  const s = Math.max(0, Math.min((boxW - 2 * pad) / w, (boxH - 2 * pad) / h))
  return { x: (boxW - w * s) / 2, y: (boxH - h * s) / 2, s }
}
