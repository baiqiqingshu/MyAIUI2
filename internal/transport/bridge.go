// Package transport 实现受限 HTTP 传输桥：只连接 AppAPI 解析出的精确 origin，
// 并把响应按 headers/chunk/end/error 事件流式推送给前端。
package transport

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"myaiui2/internal/logging"
)

// 传输限制（契约 §2.6）。
const (
	defaultTimeout   = 10 * time.Minute
	headerTimeout    = 60 * time.Second
	maxRequestBytes  = 16 << 20
	maxResponseBytes = 64 << 20
	maxRedirects     = 3
	readBufferSize   = 32 << 10
	maxErrorLength   = 300
)

// 重定向策略错误，用于给前端可读的中文原因。
var (
	errCrossOriginRedirect = errors.New("禁止跨域重定向")
	errTooManyRedirects    = errors.New("重定向次数过多")
	errRelayRedirect       = errors.New("中转模式不允许重定向")
)

// Target 由 AppAPI 解析数据库后注入：真实 origin + 已解密密钥。
type Target struct {
	ID      string // provider id 或 search service id（仅用于日志）
	BaseURL string // 必须是 http/https 的绝对 URL，无 userinfo/fragment
	APIKey  string // 可为空
}

// Request 前端发起的受限请求。
type Request struct {
	ID      string // 前端生成 UUID v4
	Method  string // GET | POST
	Path    string // 相对路径，如 /v1/chat/completions?x=1
	Headers map[string]string
	Body    []byte
	Timeout time.Duration // 0 = 默认（10 分钟）
}

// Emit 由 AppAPI 注入，内部调用 runtime.EventsEmit(ctx, event, payload)。
type Emit func(event string, payload any)

// Bridge 管理进行中的受限请求；Start 立即返回，结果通过事件推送。
type Bridge struct {
	emit Emit
	rt   *http.Transport

	// relayAddr 非空时受限请求改发本地 Python 中转（如 http://127.0.0.1:52341）。
	relayAddr atomic.Value // string

	mu     sync.Mutex
	active map[string]*activeRequest
}

// activeRequest 记录单个请求的取消原因，用于区分用户取消、header 超时与总超时。
type activeRequest struct {
	cancel        context.CancelFunc
	userCancelled atomic.Bool
	headerTimeout atomic.Bool
}

// NewBridge 创建传输桥；emit 为 nil 时静默（仅测试/预初始化场景）。
func NewBridge(emit Emit) *Bridge {
	if emit == nil {
		emit = func(string, any) {}
	}
	return &Bridge{
		emit:   emit,
		active: make(map[string]*activeRequest),
		rt: &http.Transport{
			// 代理只能由 BaseURL 决定，不读环境代理，避免请求被改道。
			Proxy:                 nil,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          8,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ExpectContinueTimeout: time.Second,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		},
	}
}

// SetRelay 设置本地 Python 中转基址（如 http://127.0.0.1:52341）；空串关闭中转恢复直连。
func (b *Bridge) SetRelay(addr string) {
	b.relayAddr.Store(strings.TrimSpace(addr))
}

// relay 返回当前中转基址；未启用为 ""。
func (b *Bridge) relay() string {
	if v := b.relayAddr.Load(); v != nil {
		return v.(string)
	}
	return ""
}

// Start 校验并启动请求，立即返回；流式结果通过事件推送。
func (b *Bridge) Start(req Request, target Target) error {
	if strings.TrimSpace(req.ID) == "" {
		return errors.New("请求 ID 不能为空")
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method != http.MethodGet && method != http.MethodPost {
		return errors.New("不支持的请求方法")
	}
	if len(req.Body) > maxRequestBytes {
		return errors.New("请求内容超过 16MB 上限")
	}
	endpoint, err := ResolveEndpoint(target.BaseURL, req.Path)
	if err != nil {
		return err
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	b.mu.Lock()
	if _, exists := b.active[req.ID]; exists {
		b.mu.Unlock()
		return errors.New("请求已在进行中")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	active := &activeRequest{cancel: cancel}
	b.active[req.ID] = active
	b.mu.Unlock()

	logging.Infof("transport 开始请求 %s %s (target=%s)", method, endpoint.Path, target.ID)
	go b.run(ctx, req, target, endpoint, active)
	return nil
}

// Cancel 取消进行中的请求（含上游连接）。
func (b *Bridge) Cancel(id string) error {
	b.mu.Lock()
	active, ok := b.active[id]
	b.mu.Unlock()
	if !ok {
		return errors.New("请求不存在或已结束")
	}
	active.userCancelled.Store(true)
	active.cancel()
	return nil
}

// ActiveCount 返回进行中的请求数量。
func (b *Bridge) ActiveCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.active)
}

// run 执行请求：headers → chunk… → end/error，全部在同一 goroutine 内顺序推送。
func (b *Bridge) run(ctx context.Context, req Request, target Target, endpoint *url.URL, active *activeRequest) {
	defer func() {
		active.cancel()
		b.mu.Lock()
		delete(b.active, req.ID)
		b.mu.Unlock()
	}()

	resp, err := b.do(ctx, req, target, endpoint, active)
	if err != nil {
		b.emitError(req.ID, 0, b.describeError(active, err))
		return
	}
	defer resp.Body.Close()

	b.emit(EventHeaders, HeadersPayload{
		RequestID:  req.ID,
		Status:     resp.StatusCode,
		StatusText: http.StatusText(resp.StatusCode),
		Headers:    FilterResponseHeaders(resp.Header),
	})

	if resp.ContentLength > maxResponseBytes {
		b.emitError(req.ID, resp.StatusCode, "响应内容超过 64MB 上限")
		return
	}

	buf := make([]byte, readBufferSize)
	var total int64
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > maxResponseBytes {
				b.emitError(req.ID, resp.StatusCode, "响应内容超过 64MB 上限")
				return
			}
			b.emit(EventChunk, ChunkPayload{
				RequestID:  req.ID,
				DataBase64: base64.StdEncoding.EncodeToString(buf[:n]),
			})
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				b.emit(EventEnd, EndPayload{RequestID: req.ID})
				return
			}
			b.emitError(req.ID, resp.StatusCode, b.describeError(active, readErr))
			return
		}
	}
}

// do 组装并发送单次请求；header 等待超时通过取消 context 实现。
func (b *Bridge) do(ctx context.Context, req Request, target Target, endpoint *url.URL, active *activeRequest) (*http.Response, error) {
	var body io.Reader
	if len(req.Body) > 0 {
		body = bytes.NewReader(req.Body)
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	// origin/path 校验已在 Start 的 ResolveEndpoint 完成；
	// 中转只改实际投递地址：TCP 连接打到 127.0.0.1，真实目标放进 X-Relay-URL。
	relayAddr := b.relay()
	wireMethod, wireURL := method, endpoint.String()
	if relayAddr != "" {
		wireMethod = http.MethodPost
		wireURL = strings.TrimSuffix(relayAddr, "/") + "/relay"
	}
	hreq, err := http.NewRequestWithContext(ctx, wireMethod, wireURL, body)
	if err != nil {
		return nil, errors.New("请求构造失败")
	}
	for name, value := range FilterRequestHeaders(req.Headers) {
		hreq.Header.Set(name, value)
	}
	// 真实密钥由 Bridge 注入；浏览器凭据一律不带。
	hreq.Header.Del("Cookie")
	hreq.Header.Del("Referer")
	hreq.Header.Del("Origin")
	if target.APIKey != "" {
		hreq.Header.Set("Authorization", "Bearer "+target.APIKey)
	} else {
		hreq.Header.Del("Authorization")
	}
	if relayAddr != "" {
		// X-Relay-* 在过滤/注入之后写入，前端伪造的同名头一律被覆盖。
		hreq.Header.Set("X-Relay-Method", method)
		hreq.Header.Set("X-Relay-URL", endpoint.String())
		if deadline, ok := ctx.Deadline(); ok {
			secs := int64(time.Until(deadline).Seconds()) + 1
			if secs < 1 {
				secs = 1
			}
			hreq.Header.Set("X-Relay-Timeout", strconv.FormatInt(secs, 10))
		}
	}

	timer := time.AfterFunc(headerTimeout, func() {
		active.headerTimeout.Store(true)
		active.cancel()
	})
	defer timer.Stop()
	trace := &httptrace.ClientTrace{
		GotFirstResponseByte: func() { timer.Stop() },
	}
	hreq = hreq.WithContext(httptrace.WithClientTrace(hreq.Context(), trace))

	client := &http.Client{
		Transport:     b.rt,
		CheckRedirect: b.checkRedirect(endpoint),
	}
	if relayAddr != "" {
		// Python 中转不跟随重定向；Go 侧同步拒绝，避免对 relay URL 做无意义的 origin 校验。
		client.CheckRedirect = func(*http.Request, []*http.Request) error {
			return errRelayRedirect
		}
	}
	return client.Do(hreq)
}

// checkRedirect 只允许同 origin 重定向，最多 3 跳，并剥离凭据类头。
func (b *Bridge) checkRedirect(origin *url.URL) func(*http.Request, []*http.Request) error {
	return func(next *http.Request, via []*http.Request) error {
		if len(via) > maxRedirects {
			return errTooManyRedirects
		}
		if !sameOrigin(origin, next.URL) {
			return errCrossOriginRedirect
		}
		next.Header.Del("Cookie")
		next.Header.Del("Referer")
		next.Header.Del("Origin")
		return nil
	}
}

// describeError 把底层错误转成前端可读的中文原因（必要时再经 Redact 截断）。
func (b *Bridge) describeError(active *activeRequest, err error) string {
	switch {
	case active.userCancelled.Load():
		return "请求已取消"
	case active.headerTimeout.Load():
		return "等待响应超时（60 秒）"
	case errors.Is(err, errCrossOriginRedirect):
		return errCrossOriginRedirect.Error()
	case errors.Is(err, errTooManyRedirects):
		return errTooManyRedirects.Error()
	case errors.Is(err, errRelayRedirect):
		return errRelayRedirect.Error()
	case errors.Is(err, context.DeadlineExceeded):
		return "请求超时"
	case errors.Is(err, context.Canceled):
		return "请求已取消"
	}
	return err.Error()
}

func (b *Bridge) emitError(id string, status int, message string) {
	b.emit(EventError, ErrorPayload{
		RequestID: id,
		Status:    status,
		Message:   sanitizeMessage(message),
	})
}

// sanitizeMessage 脱敏并截断错误文本（契约 §2.6：Redact + 300 字符）。
func sanitizeMessage(message string) string {
	message = strings.TrimSpace(logging.Redact(message))
	return truncateRunes(message, maxErrorLength)
}

// truncateRunes 按字符边界截断，避免切断 UTF-8。
func truncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}
