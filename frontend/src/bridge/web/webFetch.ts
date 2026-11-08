import type { ProviderDTO } from '../../domain/dto'
import { getProviderKey } from './db'

// 浏览器直连版模型请求 fetch：AI SDK 给出完整 URL 与 init，原样转发到 provider；
// 真实密钥从 localStorage 取出后在这里注入 Authorization（对应 Go 侧 Transport 的
// 密钥注入职责），SDK 里的 apiKey 占位符不会被发出去。init.signal 原生透传即支持取消。
export function createWebFetch(provider: ProviderDTO): typeof fetch {
  return function webFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : null
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    // Request 自带的头做基底，init 里的头覆盖之（与 wailsFetch 的取值顺序一致）。
    const headers = new Headers(request?.headers)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    }
    const apiKey = getProviderKey(provider.ID)
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
    else headers.delete('authorization')

    if (request && init == null) {
      // 只给 Request 没有 init：克隆原请求换头，保留方法/请求体/凭证模式。
      return fetch(new Request(request, { headers }))
    }
    return fetch(url, { ...init, headers })
  }
}
