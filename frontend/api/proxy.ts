// 通用 HTTP 代理（Vercel Edge Function）：浏览器端把目标地址放在
// /api/proxy?url=<encodeURIComponent(目标)>，函数代为转发并把响应流式透传，
// 使 Web 版访问不支持 CORS 的 provider / searxng 也能工作。
//
// 安全边界：
// - 仅允许 http/https，且按主机名拦截内网/环回/链路本地地址（防 SSRF 打云内网）；
// - 可选环境变量 PROXY_ALLOWED_HOSTS：逗号分隔的域名后缀白名单，配置后只放行
//   命中的主机（如 "openai.com,openrouter.ai"）。未配置则放行所有公网主机。
// - 密钥仍由浏览器端注入 Authorization 头，本函数不存储、不校验密钥；
//   站点公网可达时建议在 Vercel 开启 Deployment Protection，避免被当公共代理滥用。

export const config = { runtime: 'edge' }

// 逐跳头/身份头不进上游；content-length 由 fetch 按实际 body 重算。
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
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
])

// fetch 会透明解压，必须剥掉 content-encoding / content-length，
// 否则浏览器拿到的是已解压 body 却按 gzip 再解一次。set-cookie 不下发，
// 避免上游把 cookie 种到本站域名下。
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
])

// 所有响应（含错误）都带特征头：前端据此判断 /api/proxy 是否由本函数实现
// （静态托管的 404 页面无此头 → 前端退回直连）。对应 webFetch.ts PROXY_MARKER。
const MARKER = { 'x-myaiui2-proxy': '1' } as const

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...MARKER },
  })
}

/** 按主机名拦截内网/保留地址（DNS 解析在云端，只能挡字面量，属尽力而为）。 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true
  if (/\.(local|internal|lan|home|corp)$/.test(h)) return true
  // IPv6：环回/未指定/链路本地/ULA；v4-mapped 一律拦（正常 provider 不会用）。
  if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1' || h === '0:0:0:0:0:0:0:0') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('::ffff:')) {
    return true
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 198 && (b === 18 || b === 19)) return true
  }
  return false
}

function allowedHosts(): string[] {
  const raw =
    typeof process !== 'undefined' && process.env ? process.env.PROXY_ALLOWED_HOSTS : undefined
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function hostAllowed(hostname: string): boolean {
  const list = allowedHosts()
  if (list.length === 0) return true
  const h = hostname.toLowerCase()
  return list.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))
}

export default async function handler(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('url')
  if (!raw) return jsonError(400, '缺少 url 参数')

  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return jsonError(400, 'url 参数不是合法 URL')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return jsonError(400, '仅允许 http/https 目标')
  }
  if (isPrivateHost(target.hostname)) return jsonError(403, '目标主机不被允许')
  if (!hostAllowed(target.hostname)) return jsonError(403, '目标主机不在白名单内')

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (STRIP_REQUEST_HEADERS.has(k) || k.startsWith('x-vercel-')) return
    headers.set(k, value)
  })
  // 目标 URL 自带 userinfo 时转成 Basic 头（浏览器 fetch 不接受 userinfo URL）。
  if (target.username && !headers.has('authorization')) {
    headers.set('authorization', `Basic ${btoa(`${target.username}:${target.password}`)}`)
  }
  target.username = ''
  target.password = ''

  const method = request.method.toUpperCase()
  let upstream: Response
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? null : request.body,
      redirect: 'follow',
    })
  } catch {
    return jsonError(502, '无法连接目标服务')
  }

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return
    responseHeaders.set(key, value)
  })
  responseHeaders.set('cache-control', 'no-store')
  responseHeaders.set('x-myaiui2-proxy', MARKER['x-myaiui2-proxy'])
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}
