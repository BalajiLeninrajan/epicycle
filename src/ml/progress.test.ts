import { describe, expect, it } from 'vitest'
import { createProgress, sharedLoader } from './progress'

describe('createProgress', () => {
  it('weights files by bytes', () => {
    const seen: number[] = []
    const p = createProgress((v) => seen.push(v), { a: 100, b: 300 })
    p.file('a', 100, 100)
    expect(seen.at(-1)).toBeCloseTo(0.25)
    p.file('b', 150, 300)
    expect(seen.at(-1)).toBeCloseTo(0.625)
  })

  it('never decreases when a new file appears', () => {
    const seen: number[] = []
    const p = createProgress((v) => seen.push(v))
    p.file('a', 50, 100)
    p.file('b', 0, 900)
    p.file('a', 100, 100)
    p.file('b', 900, 900)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(seen.at(-1)).toBeLessThan(1)
  })

  it('stays below 1 until done, then reports 1 once', () => {
    const seen: number[] = []
    const p = createProgress((v) => seen.push(v), { a: 10 })
    p.file('a', 10, 10)
    expect(seen.at(-1)).toBeLessThan(1)
    p.done()
    p.done()
    p.file('a', 10, 10)
    expect(seen.filter((v) => v === 1)).toHaveLength(1)
    expect(seen.at(-1)).toBe(1)
  })

  it('keeps a known size when an event has no total', () => {
    const seen: number[] = []
    const p = createProgress((v) => seen.push(v), { a: 1000 })
    p.file('a', 500, 0)
    expect(seen.at(-1)).toBeCloseTo(0.5)
  })

  it('reports nothing while every total is unknown', () => {
    const seen: number[] = []
    const p = createProgress((v) => seen.push(v))
    p.file('a', 10, 0)
    // loaded grows the total, so this is 10/10 capped below 1
    expect(seen.every((v) => v < 1)).toBe(true)
  })

  it('aggregates transformers.js events under a prefix', () => {
    const seen: number[] = []
    const p = createProgress((v) => seen.push(v), { runtime: 100, 'm/onnx/a.onnx': 100 })
    p.transformers(
      {
        status: 'progress_total',
        name: 'm',
        progress: 0,
        loaded: 0,
        total: 300,
        files: { 'onnx/a.onnx': { loaded: 0, total: 100 }, 'onnx/b.onnx': { loaded: 0, total: 200 } },
      },
      'm',
    )
    p.transformers({ status: 'progress', name: 'm', file: 'onnx/b.onnx', progress: 50, loaded: 100, total: 200 }, 'm')
    expect(seen.at(-1)).toBeCloseTo(100 / 400)
    // A cache hit can finish without byte events.
    p.transformers({ status: 'done', name: 'm', file: 'onnx/a.onnx' }, 'm')
    expect(seen.at(-1)).toBeCloseTo(200 / 400)
    p.transformers({ status: 'initiate', name: 'm', file: 'x' }, 'm')
    expect(seen.at(-1)).toBeCloseTo(200 / 400)
  })
})

describe('sharedLoader', () => {
  it('returns the same promise to concurrent and later callers', async () => {
    let calls = 0
    let resolve!: (v: string) => void
    const load = sharedLoader(() => {
      calls++
      return new Promise<string>((r) => (resolve = r))
    })
    const a: number[] = []
    const b: number[] = []
    const p1 = load((v) => a.push(v))
    const p2 = load((v) => b.push(v))
    expect(p1).toBe(p2)
    resolve('ok')
    await expect(p1).resolves.toBe('ok')
    expect(load()).toBe(p1)
    expect(calls).toBe(1)
    expect(a.at(-1)).toBe(1)
    expect(b.at(-1)).toBe(1)
  })

  it('fans progress out to every caller', async () => {
    let report!: (p: number) => void
    let resolve!: () => void
    const load = sharedLoader((onProgress) => {
      report = onProgress
      return new Promise<void>((r) => (resolve = r))
    })
    const a: number[] = []
    const b: number[] = []
    const p = load((v) => a.push(v))
    report(0.2)
    load((v) => b.push(v))
    report(0.6)
    resolve()
    await p
    expect(a).toEqual([0.2, 0.6, 1])
    expect(b).toEqual([0.6, 1])
  })

  it('tells callers after completion that the load is done', async () => {
    const load = sharedLoader(async () => 1)
    await load()
    const seen: number[] = []
    await load((v) => seen.push(v))
    expect(seen).toEqual([1])
  })

  it('retries after a failure', async () => {
    let calls = 0
    const load = sharedLoader(async () => {
      calls++
      if (calls === 1) throw new Error('offline')
      return 'ok'
    })
    await expect(load()).rejects.toThrow('offline')
    await expect(load()).resolves.toBe('ok')
    expect(calls).toBe(2)
  })

  it('turns a synchronous throw into a rejection', async () => {
    const load = sharedLoader((): Promise<void> => {
      throw new Error('boom')
    })
    await expect(load()).rejects.toThrow('boom')
  })
})
