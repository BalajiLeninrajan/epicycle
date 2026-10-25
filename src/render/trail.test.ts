import { describe, expect, it } from 'vitest'
import {
  FADE_BUCKETS,
  bucketAlpha,
  bucketStart,
  fadeLength,
  resampleJump,
  trailSize,
  traceTrail,
  type PathSink,
} from './trail'

class Recorder implements PathSink {
  ops: string[] = []
  moveTo(x: number, y: number): void {
    this.ops.push(`M${x},${y}`)
  }
  lineTo(x: number, y: number): void {
    this.ops.push(`L${x},${y}`)
  }
}

function line(n: number): { xs: Float64Array; ys: Float64Array } {
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = i
    ys[i] = -i
  }
  return { xs, ys }
}

describe('traceTrail', () => {
  const trace = (xs: Float64Array, ys: Float64Array, jump: Uint8Array | null, start: number, count: number, tip?: [number, number]) => {
    const main = new Recorder()
    const jumps = new Recorder()
    traceTrail(main, jumps, xs, ys, jump, start, count, 0, 0, 1, tip?.[0], tip?.[1])
    return { main: main.ops, jumps: jumps.ops }
  }

  it('draws one connected run without jumps', () => {
    const { xs, ys } = line(4)
    expect(trace(xs, ys, null, 0, 4)).toEqual({ main: ['M0,0', 'L1,-1', 'L2,-2', 'L3,-3'], jumps: [] })
  })

  it('applies the screen transform', () => {
    const { xs, ys } = line(2)
    const r = new Recorder()
    traceTrail(r, r, xs, ys, null, 0, 2, 10, 20, 3)
    expect(r.ops).toEqual(['M10,20', 'L13,17'])
  })

  it('sends links touching a jump sample to the jump sink', () => {
    const { xs, ys } = line(6)
    const out = trace(xs, ys, Uint8Array.from([0, 0, 1, 1, 0, 0]), 0, 6)
    expect(out.main).toEqual(['M0,0', 'L1,-1', 'M4,-4', 'L5,-5'])
    expect(out.jumps).toEqual(['M1,-1', 'L2,-2', 'L3,-3', 'L4,-4'])
  })

  it('appends the tip, classed like the last point', () => {
    const { xs, ys } = line(3)
    expect(trace(xs, ys, null, 0, 3, [9, 9]).main.at(-1)).toBe('L9,9')
    const out = trace(xs, ys, Uint8Array.from([0, 0, 1]), 0, 3, [9, 9])
    expect(out.jumps.at(-1)).toBe('L9,9')
    expect(out.main).toEqual(['M0,0', 'L1,-1'])
  })

  it('wraps past the end, including negative starts', () => {
    const { xs, ys } = line(4)
    expect(trace(xs, ys, null, -1, 3).main).toEqual(['M3,-3', 'L0,0', 'L1,-1'])
  })

  it('closes the loop with count = n + 1', () => {
    const { xs, ys } = line(3)
    expect(trace(xs, ys, null, 0, 4).main).toEqual(['M0,0', 'L1,-1', 'L2,-2', 'L0,0'])
  })

  it('draws nothing for empty input, zero count or a single point', () => {
    expect(trace(new Float64Array(0), new Float64Array(0), null, 0, 5)).toEqual({ main: [], jumps: [] })
    const { xs, ys } = line(3)
    expect(trace(xs, ys, null, 0, 0)).toEqual({ main: [], jumps: [] })
    expect(trace(Float64Array.of(1), Float64Array.of(2), null, 0, 1)).toEqual({ main: [], jumps: [] })
  })
})

describe('fade buckets', () => {
  it('cover the whole tail, sharing endpoints', () => {
    for (const len of [2, 5, 8, 9, 100, 1229]) {
      expect(bucketStart(0, FADE_BUCKETS, len)).toBe(0)
      expect(bucketStart(FADE_BUCKETS, FADE_BUCKETS, len)).toBe(len - 1)
      for (let b = 0; b < FADE_BUCKETS; b++) {
        expect(bucketStart(b + 1, FADE_BUCKETS, len)).toBeGreaterThanOrEqual(bucketStart(b, FADE_BUCKETS, len))
      }
    }
  })

  it('alpha rises from oldest to newest and ends opaque', () => {
    let prev = 0
    for (let b = 0; b < FADE_BUCKETS; b++) {
      const a = bucketAlpha(b, FADE_BUCKETS)
      expect(a).toBeGreaterThan(prev)
      prev = a
    }
    expect(prev).toBe(1)
  })

  it('tail length stays within [2, n]', () => {
    expect(fadeLength(2)).toBe(2)
    expect(fadeLength(4096)).toBe(4096)
    expect(fadeLength(1)).toBe(1)
  })
})

describe('trailSize / resampleJump', () => {
  it('rounds up to a power of 2', () => {
    expect(trailSize(0)).toBe(2)
    expect(trailSize(2)).toBe(2)
    expect(trailSize(3)).toBe(4)
    expect(trailSize(4096)).toBe(4096)
    expect(trailSize(5000)).toBe(8192)
  })

  it('returns the same array when the size matches', () => {
    const j = Uint8Array.from([0, 1, 0, 1])
    expect(resampleJump(j, 4)).toBe(j)
  })

  it('stretches flags to a larger size', () => {
    expect(Array.from(resampleJump(Uint8Array.from([0, 1, 0]), 6))).toEqual([0, 0, 1, 1, 0, 0])
    expect(Array.from(resampleJump(new Uint8Array(0), 4))).toEqual([0, 0, 0, 0])
  })
})
