// Streamed downloads kept in the Cache API, for files we fetch ourselves
// (ORT runtime, line-art model). transformers.js caches its own files.

export const MODEL_CACHE = 'fd-models-v1'

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(MODEL_CACHE)
  } catch {
    // Cache API can be unavailable (insecure context, storage disabled). Just download.
    return null
  }
}

/** Read a response body in chunks, reporting bytes as they arrive. */
export async function readBody(
  res: Response,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const header = Number(res.headers.get('Content-Length'))
  // Content-Length is the encoded size; a compressed body may decode to more bytes.
  const encoded = res.headers.get('Content-Encoding')
  const total = Number.isFinite(header) && header > 0 && !encoded ? header : 0
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    onBytes(buf.length, buf.length)
    return buf
  }
  const reader = res.body.getReader()
  let out = new Uint8Array(total || 1 << 20)
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (loaded + value.length > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, loaded + value.length))
      grown.set(out.subarray(0, loaded))
      out = grown
    }
    out.set(value, loaded)
    loaded += value.length
    onBytes(loaded, total)
  }
  onBytes(loaded, loaded)
  return loaded === out.length ? out : out.slice(0, loaded)
}

/**
 * GET url, served from MODEL_CACHE when present. Downloads are streamed for progress
 * and stored for offline use. Rejects with the URL and HTTP status on failure.
 */
export async function fetchCached(
  url: string,
  onBytes: (loaded: number, total: number) => void = () => {},
): Promise<Uint8Array<ArrayBuffer>> {
  const cache = await openCache()
  const hit = await cache?.match(url).catch(() => undefined)
  if (hit) {
    try {
      return await readBody(hit, onBytes)
    } catch {
      // Corrupt entry; fall through to the network.
      await cache?.delete(url).catch(() => false)
    }
  }

  let res: Response
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit' })
  } catch (err) {
    throw new Error(`Download failed for ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new Error(`Download failed for ${url}: HTTP ${res.status}`)
  const bytes = await readBody(res, onBytes)

  if (cache) {
    const type = res.headers.get('Content-Type') ?? 'application/octet-stream'
    const stored = new Response(bytes, { headers: { 'Content-Type': type, 'Content-Length': String(bytes.length) } })
    // Quota errors only cost us the offline copy.
    await cache.put(url, stored).catch(() => {})
  }
  return bytes
}
