import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  baseName,
  containFit,
  errorMessage,
  formatClock,
  isSvgFile,
  latestRunner,
  logToInt,
  logToValue,
  valueToLog,
} from './logic'

describe('log slider mapping', () => {
  it('hits both ends exactly', () => {
    expect(logToValue(0, 1, 4096)).toBeCloseTo(1, 12)
    expect(logToValue(1000, 1, 4096)).toBeCloseTo(4096, 9)
    expect(valueToLog(1, 1, 4096)).toBe(0)
    expect(valueToLog(4096, 1, 4096)).toBe(1000)
  })

  it('puts the geometric mean at the midpoint', () => {
    expect(logToValue(500, 1, 10000)).toBeCloseTo(100, 9)
    expect(valueToLog(100, 1, 10000)).toBe(500)
  })

  it('round trips every position for integer ranges', () => {
    for (const max of [2048, 4096, 8192]) {
      for (let pos = 0; pos <= 1000; pos += 7) {
        const k = logToInt(pos, 1, max)
        expect(k).toBeGreaterThanOrEqual(1)
        expect(k).toBeLessThanOrEqual(max)
        // Integer rounding can move the position, but it must land on the same integer.
        expect(logToInt(valueToLog(k, 1, max), 1, max)).toBe(k)
      }
    }
  })

  it('is monotonic', () => {
    let prev = 0
    for (let pos = 0; pos <= 1000; pos++) {
      const k = logToInt(pos, 1, 4096)
      expect(k).toBeGreaterThanOrEqual(prev)
      prev = k
    }
  })

  it('clamps out-of-range and junk input', () => {
    expect(logToValue(-50, 2, 8)).toBeCloseTo(2, 12)
    expect(logToValue(5000, 2, 8)).toBeCloseTo(8, 12)
    expect(logToValue(Number.NaN, 2, 8)).toBeCloseTo(2, 12)
    expect(valueToLog(0, 1, 100)).toBe(0)
    expect(valueToLog(1e9, 1, 100)).toBe(1000)
    expect(valueToLog(Number.NaN, 1, 100)).toBe(0)
  })

  it('handles a degenerate range', () => {
    expect(logToValue(500, 1, 1)).toBe(1)
    expect(valueToLog(1, 1, 1)).toBe(0)
    expect(logToInt(700, 1, 1)).toBe(1)
    expect(logToValue(500, 0, 10)).toBe(0)
  })
})

describe('latestRunner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function deferred<T>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  const tick = () => new Promise((r) => setImmediate(r))

  it('debounces bursts into one run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const task = vi.fn(() => Promise.resolve(1))
    const onResult = vi.fn()
    const r = latestRunner(task, { delay: 120, onResult, onError: () => {} })
    r.schedule()
    vi.advanceTimersByTime(100)
    r.schedule()
    vi.advanceTimersByTime(100)
    r.schedule()
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(120)
    expect(task).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    await tick()
    expect(onResult).toHaveBeenCalledWith(1)
  })

  it('drops an in-flight result once a newer run is scheduled, and stays busy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = deferred<string>()
    const queue = [first.promise, Promise.resolve('new')]
    const onResult = vi.fn()
    const busy: boolean[] = []
    const r = latestRunner(() => queue.shift()!, { delay: 120, onResult, onError: () => {}, onBusy: (v) => busy.push(v) })
    r.flush()
    r.schedule()
    first.resolve('old')
    vi.useRealTimers()
    await tick()
    expect(onResult).not.toHaveBeenCalled()
    expect(busy.at(-1)).toBe(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    r.schedule()
    vi.advanceTimersByTime(120)
    vi.useRealTimers()
    await tick()
    expect(onResult).toHaveBeenCalledWith('new')
    expect(busy.at(-1)).toBe(false)
  })

  it('drops a stale result that arrives after a newer one', async () => {
    const a = deferred<string>()
    const b = deferred<string>()
    const queue = [a, b]
    const onResult = vi.fn()
    const busy: boolean[] = []
    const r = latestRunner(() => queue.shift()!.promise, {
      delay: 0,
      onResult,
      onError: () => {},
      onBusy: (v) => busy.push(v),
    })
    r.flush()
    r.flush()
    b.resolve('new')
    await tick()
    a.resolve('old')
    await tick()
    expect(onResult.mock.calls).toEqual([['new']])
    expect(busy).toEqual([true, true, false])
  })

  it('drops a stale error', async () => {
    const a = deferred<number>()
    const b = deferred<number>()
    const queue = [a, b]
    const onError = vi.fn()
    const onResult = vi.fn()
    const r = latestRunner(() => queue.shift()!.promise, { delay: 0, onResult, onError })
    r.flush()
    r.flush()
    a.reject(new Error('old'))
    b.resolve(2)
    await tick()
    expect(onError).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith(2)
  })

  it('reports the latest error, including a synchronous throw', async () => {
    const onError = vi.fn()
    const r = latestRunner<number>(
      () => {
        throw new Error('boom')
      },
      { delay: 0, onResult: () => {}, onError },
    )
    r.flush()
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(errorMessage(onError.mock.calls[0][0])).toBe('boom')
  })

  it('flush cancels the pending scheduled run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const task = vi.fn(() => Promise.resolve(0))
    const r = latestRunner(task, { delay: 120, onResult: () => {}, onError: () => {} })
    r.schedule()
    r.flush()
    vi.advanceTimersByTime(500)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('cancel drops pending and in-flight runs', async () => {
    const a = deferred<number>()
    const onResult = vi.fn()
    const busy: boolean[] = []
    const r = latestRunner(() => a.promise, { delay: 0, onResult, onError: () => {}, onBusy: (v) => busy.push(v) })
    r.flush()
    r.cancel()
    a.resolve(5)
    await tick()
    expect(onResult).not.toHaveBeenCalled()
    expect(busy).toEqual([true, false])
  })
})

describe('small helpers', () => {
  it('baseName strips folders, extensions and unsafe characters', () => {
    expect(baseName('photo.jpeg')).toBe('photo')
    expect(baseName('C:\\a\\b\\my cat (1).png')).toBe('my-cat-1')
    expect(baseName('/tmp/x.tar.gz')).toBe('x.tar')
    expect(baseName('')).toBe('drawing')
    expect(baseName('???.svg')).toBe('drawing')
  })

  it('isSvgFile checks type and extension', () => {
    expect(isSvgFile('image/svg+xml', 'a')).toBe(true)
    expect(isSvgFile('', 'LOGO.SVG')).toBe(true)
    expect(isSvgFile('image/png', 'a.png')).toBe(false)
  })

  it('formatClock pads seconds', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65.9)).toBe('1:05')
    expect(formatClock(-3)).toBe('0:00')
    expect(formatClock(Number.NaN)).toBe('0:00')
  })

  it('containFit centers and keeps the margin', () => {
    const f = containFit(200, 100, 1000, 1000, 0)
    expect(f.s).toBe(5)
    expect(f.x).toBe(0)
    expect(f.y).toBe(250)
    const m = containFit(100, 100, 400, 200, 0.1)
    expect(m.s).toBeCloseTo(1.6, 12)
    expect(m.x).toBeCloseTo(120, 12)
    expect(m.y).toBeCloseTo(20, 12)
    expect(containFit(0, 10, 100, 100)).toEqual({ x: 0, y: 0, s: 0 })
    expect(containFit(10, 10, 0, 100)).toEqual({ x: 0, y: 0, s: 0 })
  })
})
