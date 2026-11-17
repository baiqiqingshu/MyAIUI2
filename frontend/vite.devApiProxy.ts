import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

// api/proxy.ts（Vercel Edge Function）的开发等价物：同一 /api/proxy?url=<目标>
// 入口，浏览器在 dev 下同样同源访问。差异：本地中间件不拦内网地址——
// 本机 Ollama 等 provider 就是 localhost，且请求本就从用户机器发出。
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'origin',
  'referer',
  'cookie',
])

const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
])

// 与 api/proxy.ts 一致的特征头：前端据此判断代理是否存在（webFetch.ts PROXY_MARKER）。
const MARKER = { 'x-myaiui2-proxy': '1' } as const

function sendJson(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...MARKER })
  res.end(JSON.stringify({ error: message }))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('url')
  if (!raw) {
    sendJson(res, 400, '缺少 url 参数')
    return
  }
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    sendJson(res, 400, 'url 参数不是合法 URL')
    return
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    sendJson(res, 400, '仅允许 http/https 目标')
    return
  }

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIP_REQUEST_HEADERS.has(key)) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  if (target.username && !headers.has('authorization')) {
    headers.set('authorization', `Basic ${btoa(`${target.username}:${target.password}`)}`)
  }
  target.username = ''
  target.password = ''

  const abort = new AbortController()
  res.on('close', () => abort.abort())

  const method = (req.method ?? 'GET').toUpperCase()
  let upstream: Response
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers,
      // IncomingMessage 是 AsyncIterable，undici 可直接消费为请求体。
      body: method === 'GET' || method === 'HEAD' ? undefined : (req as never),
      redirect: 'follow',
      signal: abort.signal,
      // @ts-expect-error undici 流式请求体要求 duplex（node 类型尚未暴露该字段）。
      duplex: 'half',
    })
  } catch {
    if (!res.headersSent) sendJson(res, 502, '无法连接目标服务')
    else res.destroy()
    return
  }

  const responseHeaders: Record<string, string> = {
    'cache-control': 'no-store',
    ...MARKER,
  }
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value
  })
  res.writeHead(upstream.status, upstream.statusText, responseHeaders)
  if (upstream.body) {
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res)
  } else {
    res.end()
  }
}

export function devApiProxy(): Plugin {
  return {
    name: 'myaiui2-dev-api-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/proxy', (req, res) => {
        void handle(req, res)
      })
    },
  }
}
