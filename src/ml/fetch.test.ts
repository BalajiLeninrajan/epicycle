import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCached, readBody } from './fetch'

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch)
      c.close()
    },
  })
  return new Response(body, { headers })
}

describe('readBody', () => {
  it('concatenates chunks and reports progress against Content-Length', async () => {
    const seen: [number, number][] = []
    const res = streamed([Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5, 6)], { 'Content-Length': '6' })
    const out = await readBody(res, (l, t) => seen.push([l, t]))
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6])
    expect(seen).toEqual([
      [2, 6],
      [3, 6],
      [6, 6],
      [6, 6],
    ])
  })

  it('grows the buffer when the size is unknown', async () => {
    const big = new Uint8Array(3 << 20).map((_, i) => i & 255)
    const out = await readBody(streamed([big.subarray(0, 1 << 20), big.subarray(1 << 20)]), () => {})
    expect(out.length).toBe(big.length)
    expect(out[(2 << 20) + 7]).toBe(big[(2 << 20) + 7])
  })

  it('ignores Content-Length for encoded bodies', async () => {
    const seen: number[] = []
    const res = streamed([Uint8Array.of(1, 2, 3)], { 'Content-Length': '2', 'Content-Encoding': 'gzip' })
    const out = await readBody(res, (_, t) => seen.push(t))
    expect(out.length).toBe(3)
    expect(seen[0]).toBe(0)
  })

  it('handles an empty body', async () => {
    const out = await readBody(new Response(new Uint8Array(0)), () => {})
    expect(out.length).toBe(0)
  })
})

describe('fetchCached', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('downloads without the Cache API', async () => {
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed([Uint8Array.of(7, 8, 9)], { 'Content-Length': '3' })),
    )
    const out = await fetchCached('https://example.test/m.onnx')
    expect(Array.from(out)).toEqual([7, 8, 9])
  })

  it('serves a cache hit without the network and stores misses', async () => {
    const store = new Map<string, Response>()
    const cache = {
      match: async (k: string) => store.get(k)?.clone(),
      put: async (k: string, r: Response) => void store.set(k, r),
      delete: async (k: string) => store.delete(k),
    }
    vi.stubGlobal('caches', { open: async () => cache })
    const fetchMock = vi.fn(async () => streamed([Uint8Array.of(1, 2)], { 'Content-Length': '2' }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await fetchCached('https://example.test/a')
    const second = await fetchCached('https://example.test/a')
    expect(Array.from(first)).toEqual([1, 2])
    expect(Array.from(second)).toEqual([1, 2])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects with the URL and status on HTTP errors', async () => {
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(fetchCached('https://example.test/missing')).rejects.toThrow(
      'Download failed for https://example.test/missing: HTTP 404',
    )
  })

  it('rejects with the URL on network errors', async () => {
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(fetchCached('https://example.test/x')).rejects.toThrow('Download failed for https://example.test/x: Failed to fetch')
  })
})
