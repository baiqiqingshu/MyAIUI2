import { appApi } from './appApi'
import { subscribeTransport } from './streamEvents'
import type { StreamSink } from './streamEvents'
import { newRequestId } from '../domain/message'
import type { ProviderRequestDTO, TransportHeadersDTO } from '../domain/dto'

// 把 AI SDK 的 fetch 调用翻译成 Go 受限 Transport 请求：请求体走 appApi，
// 响应体由 transport:headers/chunk/end/error 事件重建成 ReadableStream。
// 前端不直连外网、不接触密钥，Authorization 由 Go 侧按 provider 注入。

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // headers 事件可能先于 await 到达；先挂空 catch 避免 unhandledrejection 噪音。
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function abortError(): Error {
  const err = new Error('请求已取消')
  err.name = 'AbortError'
  return err
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function encodeBody(body: BodyInit | null | undefined): Pick<ProviderRequestDTO, 'Body' | 'BodyEncoding'> {
  if (body == null) return { Body: '', BodyEncoding: 'utf8' }
  if (typeof body === 'string') return { Body: body, BodyEncoding: 'utf8' }
  if (body instanceof Uint8Array) return { Body: bytesToBase64(body), BodyEncoding: 'base64' }
  if (body instanceof ArrayBuffer) return { Body: bytesToBase64(new Uint8Array(body)), BodyEncoding: 'base64' }
  if (ArrayBuffer.isView(body)) {
    return {
      Body: bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      BodyEncoding: 'base64',
    }
  }
  throw new Error('不支持的请求体类型')
}

function collectHeaders(input: HeadersInit | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!input) return headers
  new Headers(input).forEach((value, key) => {
    headers[key] = value
  })
  return headers
}

function toHeaders(input: Record<string, string> | null | undefined): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(input ?? {})) {
    try {
      headers.set(key, value)
    } catch {
      /* 忽略非法响应头 */
    }
  }
  return headers
}

export function createWailsFetch(providerId: string): typeof fetch {
  return async function wailsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : null
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    if (init?.body == null && request?.body) throw new Error('不支持的流式请求体')
    const body = encodeBody(init?.body)
    const requestId = newRequestId()
    const signal = init?.signal ?? request?.signal ?? null

    const dto: ProviderRequestDTO = {
      RequestID: requestId,
      ProviderID: providerId,
      Method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
      Path: url.pathname + url.search,
      Headers: collectHeaders(init?.headers ?? request?.headers),
      Body: body.Body,
      BodyEncoding: body.BodyEncoding,
      TimeoutMs: 0,
    }

    const headerEvent = deferred<TransportHeadersDTO>()
    const abort = abortError()

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    let sawHeaders = false
    let cleaned = false
    let unsubscribe: () => void = () => {}

    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
    }

    function onAbort(): void {
      // 先让 Go 侧断开上游连接，再让 SDK 看到 AbortError。
      void appApi.CancelProviderRequest(requestId).catch(() => {})
      if (sawHeaders) {
        try {
          streamController?.error(abort)
        } catch {
          /* 流已收尾 */
        }
      } else {
        headerEvent.reject(abort)
      }
      cleanup()
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      cancel() {
        // 读取方提前关闭：同步取消上游请求，避免 Go 侧连接继续占用。
        void appApi.CancelProviderRequest(requestId).catch(() => {})
        cleanup()
      },
    })

    const sink: StreamSink = {
      onHeaders(dto2) {
        sawHeaders = true
        headerEvent.resolve(dto2)
      },
      onChunk(dto2) {
        if (!streamController) return
        try {
          streamController.enqueue(base64ToBytes(dto2.DataBase64))
        } catch {
          /* 读取方已取消 */
        }
      },
      onEnd() {
        try {
          streamController?.close()
        } catch {
          /* 已关闭 */
        }
        cleanup()
      },
      onError(dto2) {
        const err = new Error(dto2.Message || '网络请求失败')
        if (sawHeaders) {
          try {
            streamController?.error(err)
          } catch {
            /* 流已收尾 */
          }
        } else {
          headerEvent.reject(err)
        }
        cleanup()
      },
    }

    unsubscribe = subscribeTransport(requestId, sink)

    if (signal) {
      if (signal.aborted) {
        cleanup()
        throw abort
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      await appApi.StartProviderRequest(dto)
    } catch (err) {
      cleanup()
      throw err instanceof Error ? err : new Error(String(err))
    }

    // 非 2xx 也照常构造 Response，由 AI SDK 决定如何报错。
    const headers = await headerEvent.promise
    const status = headers.Status >= 200 && headers.Status <= 599 ? headers.Status : 200
    const hasBody = status !== 204 && status !== 205 && status !== 304

    return new Response(hasBody ? stream : null, {
      status,
      // statusText 只能是 ASCII，Go 侧文本异常时直接丢弃，避免构造 Response 抛错。
      statusText: (headers.StatusText ?? '').replace(/[^\t\x20-\x7e]/g, '').slice(0, 64),
      headers: toHeaders(headers.Headers),
    })
  }
}
