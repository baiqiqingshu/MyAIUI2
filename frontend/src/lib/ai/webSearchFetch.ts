// 「模型 API 自带联网」：不改 SDK 的调用方式，只在发往模型服务的 JSON POST 体上注入联网参数。
// 链路：AI SDK → withWebSearchFetch(...) → createWailsFetch → Go Transport（前端始终不直连外网）。

/**
 * 在 inner fetch 外包一层“注入联网参数”的 wrapper，按 provider 协议写不同字段：
 * - kind = openai / openai-compatible（及其它走 chat/completions 的 kind）：
 *   body 合并 {"enable_search": true}（AI 中转站 / new-api 系约定；不认识该字段的服务会忽略它）
 * - kind = openai-responses：
 *   body.tools 追加 {"type":"web_search"}（已有 tools 则追加，不覆盖），并置 tool_choice:"auto"
 * 仅处理 JSON POST；解析失败或体不是字符串 JSON 时原样透传。
 */
export function withWebSearchFetch(inner: typeof fetch, kind: string): typeof fetch {
  return (input, init) => inner(input, injectWebSearch(input, init, kind))
}

function injectWebSearch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  kind: string,
): RequestInit | undefined {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'POST') return init

  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const contentType = headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) return init

  // SDK 的 JSON 请求体是字符串；其它形态（字节/流）不解析，直接透传。
  const body = init?.body
  if (typeof body !== 'string') return init

  const patchedBody = mergeWebSearchParams(body, kind)
  if (patchedBody === null) return init

  // 体长已变化，删掉让底层重算（wailsFetch 走 DTO，Go 侧本就按 body 定长、不透传 content-length）。
  headers.delete('content-length')
  return { ...init, headers, body: patchedBody }
}

function mergeWebSearchParams(text: string, kind: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const body = parsed as Record<string, unknown>

  if (kind === 'openai-responses') {
    const tools = Array.isArray(body.tools) ? [...body.tools] : []
    const hasWebSearch = tools.some(
      (tool) =>
        typeof tool === 'object' &&
        tool !== null &&
        (tool as { type?: unknown }).type === 'web_search',
    )
    if (!hasWebSearch) tools.push({ type: 'web_search' })
    body.tools = tools
    body.tool_choice = 'auto'
  } else {
    body.enable_search = true
  }
  return JSON.stringify(body)
}
