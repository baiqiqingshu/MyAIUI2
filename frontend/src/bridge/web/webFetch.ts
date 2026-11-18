import type { ProviderDTO } from '../../domain/dto'
import { getProviderKey, loadDb, mutateDb } from './db'

// 浏览器版模型请求 fetch：部署在 Vercel（或 vite dev）时，出站请求统一走同源
// /api/proxy 中转（api/proxy.ts Edge Function / vite.devApiProxy.ts 中间件），
// 规避浏览器直连 provider 的 CORS 限制；部署在没有该函数的静态托管、或直接
// 双击打开单文件时，探测不到代理特征头，自动退回浏览器直连（受 CORS 约束）。
// 真实密钥从 localStorage 取出后在这里注入 Authorization（对应 Go 侧
// Transport 的密钥注入职责），SDK 里的 apiKey 占位符不会被发出去。
export function proxyURL(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`
}

// 代理端点（含错误响应）都会带这个特征头；静态托管的 404 页面没有 → 判为无代理。
const PROXY_MARKER = 'x-myaiui2-proxy'
let probe: Promise<boolean> | null = null

/** 探测 /api/proxy 是否存在（结果缓存一次探测，全局复用；UI 也用它显示状态）。 */
export function probeWebProxy(): Promise<boolean> {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    return Promise.resolve(false)
  }
  probe ??= fetch('/api/proxy', { method: 'GET' })
    .then((resp) => resp.headers.has(PROXY_MARKER))
    .catch(() => false)
  return probe
}

// 「部署端中转」全局开关，存 db settings blob（对齐 search/proxy 设置的存法）；
// 缺省为关——默认浏览器直连 provider，部署到 Vercel 后可手动开启以免 CORS。
const SETTING_KEY_WEB_PROXY = 'web_egress_proxy'

export function getWebProxyEnabled(): boolean {
  const raw = loadDb().settings[SETTING_KEY_WEB_PROXY]
  if (!raw) return false
  try {
    return (JSON.parse(raw) as { Enabled?: boolean }).Enabled === true
  } catch {
    return false
  }
}

export function setWebProxyEnabled(enabled: boolean): void {
  mutateDb((db) => {
    db.settings[SETTING_KEY_WEB_PROXY] = JSON.stringify({ Enabled: enabled })
  })
}

function shouldUseProxy(): Promise<boolean> {
  return getWebProxyEnabled() ? probeWebProxy() : Promise.resolve(false)
}

/** 浏览器端所有外联请求的入口：开关开着且代理存在 → 走代理，否则直连。 */
export async function webOutboundFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return (await shouldUseProxy()) ? fetch(proxyURL(url), init) : fetch(url, init)
}

export function createWebFetch(provider: ProviderDTO): typeof fetch {
  return async function webFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : null
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const via = (await shouldUseProxy()) ? proxyURL(url) : url

    // Request 自带的头做基底，init 里的头覆盖之（与 wailsFetch 的取值顺序一致）。
    const headers = new Headers(request?.headers)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    }
    const apiKey = getProviderKey(provider.ID)
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
    else headers.delete('authorization')

    if (request && init == null) {
      // 只给 Request 没有 init：克隆原请求换地址与头，保留方法/请求体/凭证模式。
      return fetch(new Request(new Request(via, request), { headers }))
    }
    return fetch(via, { ...init, headers })
  }
}
