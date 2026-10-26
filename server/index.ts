// Short links for shared drawings. The client sends the deflated drawing (src/share/codec.ts);
// the Worker checks it decodes, stores it in KV under a content hash, and serves it back.
// Only the line path and animation settings ever reach here, never the picture.
import { decodeDrawing, MAX_SHARE_BYTES, shareId } from '../src/share/codec'

// Env comes from worker-configuration.d.ts (regenerate with `pnpm wrangler types server/worker-configuration.d.ts`).

const ID = /^\/api\/share\/([A-Za-z0-9_-]{12})$/

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function create(request: Request, env: Env): Promise<Response> {
  // Only the app's own pages may create links.
  const origin = request.headers.get('Origin')
  if (origin !== new URL(request.url).origin) return json({ error: 'Cross-origin requests are not allowed' }, 403)
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (!(await env.SHARE_LIMIT.limit({ key: ip })).success) return json({ error: 'Too many links; try again in a minute' }, 429)
  const declared = Number(request.headers.get('Content-Length'))
  if (declared > MAX_SHARE_BYTES) return json({ error: 'The drawing is too large to share' }, 413)

  const bytes = new Uint8Array(await request.arrayBuffer())
  try {
    await decodeDrawing(bytes)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Not a drawing' }, 400)
  }
  const id = await shareId(bytes)
  // Content-addressed, so a repeat share of the same drawing is a no-op.
  if ((await env.SHARES.get(id, 'arrayBuffer')) === null) await env.SHARES.put(id, bytes)
  return json({ id }, 201)
}

async function read(id: string, env: Env): Promise<Response> {
  const bytes = await env.SHARES.get(id, 'arrayBuffer')
  if (bytes === null) return json({ error: 'This drawing does not exist' }, 404)
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      // The id is a hash of the content, so it never changes.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/share') {
      return request.method === 'POST' ? create(request, env) : json({ error: 'Method not allowed' }, 405)
    }
    const m = ID.exec(url.pathname)
    if (m && request.method === 'GET') return read(m[1], env)
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
