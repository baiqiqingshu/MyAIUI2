import type {
  TransportChunkDTO,
  TransportEndDTO,
  TransportErrorDTO,
  TransportHeadersDTO,
} from '../domain/dto'

// 单条流式请求的事件出口：wailsFetch 用它把 Go Transport 的事件还原为 Response。
export interface StreamSink {
  onHeaders(dto: TransportHeadersDTO): void
  onChunk(dto: TransportChunkDTO): void
  onEnd(dto: TransportEndDTO): void
  onError(dto: TransportErrorDTO): void
}

const EVENT_HEADERS = 'transport:headers'
const EVENT_CHUNK = 'transport:chunk'
const EVENT_END = 'transport:end'
const EVENT_ERROR = 'transport:error'

const sinks = new Map<string, StreamSink>()
let detachAll: (() => void) | null = null

function on(event: string, handler: (payload: unknown) => void): () => void {
  const runtime = window.runtime
  if (!runtime) throw new Error('Wails 运行时不可用，无法订阅流式事件。')
  const off = runtime.EventsOn(event, handler)
  return typeof off === 'function' ? off : () => runtime.EventsOff(event)
}

// Wails 的 EventsOff 会摘掉同名事件下的全部监听，所以每个事件名只挂一个分发器，
// 再按 RequestID 路由到各自的 sink，避免取消一个请求时误伤其它并发请求。
function attach(): void {
  if (detachAll) return
  const offs = [
    on(EVENT_HEADERS, dispatchHeaders),
    on(EVENT_CHUNK, dispatchChunk),
    on(EVENT_END, dispatchEnd),
    on(EVENT_ERROR, dispatchError),
  ]
  detachAll = () => {
    for (const off of offs) off()
  }
}

// 没有活跃订阅时彻底解绑，避免事件监听泄漏。
function detachWhenIdle(): void {
  if (sinks.size > 0) return
  const detach = detachAll
  detachAll = null
  detach?.()
}

function dtoOf<T extends { RequestID: string }>(payload: unknown): T | null {
  if (!payload || typeof payload !== 'object') return null
  const dto = payload as T
  return typeof dto.RequestID === 'string' && dto.RequestID ? dto : null
}

function dispatchHeaders(payload: unknown): void {
  const dto = dtoOf<TransportHeadersDTO>(payload)
  if (dto) sinks.get(dto.RequestID)?.onHeaders(dto)
}

function dispatchChunk(payload: unknown): void {
  const dto = dtoOf<TransportChunkDTO>(payload)
  if (dto) sinks.get(dto.RequestID)?.onChunk(dto)
}

function dispatchEnd(payload: unknown): void {
  const dto = dtoOf<TransportEndDTO>(payload)
  if (dto) sinks.get(dto.RequestID)?.onEnd(dto)
}

function dispatchError(payload: unknown): void {
  const dto = dtoOf<TransportErrorDTO>(payload)
  if (dto) sinks.get(dto.RequestID)?.onError(dto)
}

/**
 * 订阅单条流式请求的 Transport 事件，返回取消订阅函数（可重复调用）。
 * 必须按 RequestID 解绑，不能整体 EventsOff，否则会打断并发的其它请求。
 */
export function subscribeTransport(requestId: string, sink: StreamSink): () => void {
  if (!requestId) throw new Error('requestId 不能为空')
  attach()
  sinks.set(requestId, sink)

  let live = true
  return () => {
    if (!live) return
    live = false
    if (sinks.get(requestId) === sink) sinks.delete(requestId)
    detachWhenIdle()
  }
}
