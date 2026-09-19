package transport

// 事件名（与前端 streamEvents.ts 一致，冻结）。
const (
	EventHeaders = "transport:headers"
	EventChunk   = "transport:chunk"
	EventEnd     = "transport:end"
	EventError   = "transport:error"
)

// HeadersPayload 事件 transport:headers 的载荷。
//
// 字段与 api.TransportHeadersDTO 完全一致：api 包 import transport，反向 import 会成环，
// 因此这里保留同名同型的结构体，AppAPI 的 Emit 直接透传给 runtime.EventsEmit 即可。
type HeadersPayload struct {
	RequestID  string
	Status     int
	StatusText string
	Headers    map[string]string
}

// ChunkPayload 事件 transport:chunk 的载荷，DataBase64 为原始响应体分片。
type ChunkPayload struct {
	RequestID  string
	DataBase64 string
}

// EndPayload 事件 transport:end 的载荷。
type EndPayload struct {
	RequestID string
}

// ErrorPayload 事件 transport:error 的载荷，Message 已脱敏并截断。
type ErrorPayload struct {
	RequestID string
	Status    int
	Message   string
}
