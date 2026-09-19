package transport

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"myaiui2/internal/platform"
)

// maxPathLength ResolveEndpoint 允许的路径（含 query）长度上限。
const maxPathLength = 1024

// 不透传给前端的响应头：逐跳头 + Cookie 类。
var hopByHopHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"set-cookie":          true,
	"set-cookie2":         true,
}

// ResolveEndpoint 校验 base+path：同 scheme/host/port、相对路径、无 `..`、长度上限 1024。
//
// BaseURL 自带路径前缀（如 `https://api.deepseek.com/v1`）时，前缀会按需补齐：
// 前端 SDK 传来的路径已含前缀（`/v1/chat/completions`）则原样使用，
// AppAPI 传来的相对路径（模型路径 `/models`）则拼成 `/v1/models`，避免出现 `/v1/v1/..`。
func ResolveEndpoint(baseURL, path string) (*url.URL, error) {
	base, err := parseBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("请求路径不能为空")
	}
	if len(path) > maxPathLength {
		return nil, errors.New("请求路径过长")
	}
	if !strings.HasPrefix(path, "/") {
		return nil, errors.New("请求路径必须是相对路径")
	}
	if strings.HasPrefix(path, "//") {
		return nil, errors.New("请求路径不允许以 // 开头")
	}
	if strings.Contains(path, "://") {
		return nil, errors.New("请求路径不允许包含协议")
	}
	ref, err := url.Parse(path)
	if err != nil {
		return nil, errors.New("请求路径非法")
	}
	if ref.Scheme != "" || ref.Host != "" || ref.User != nil {
		return nil, errors.New("请求路径不允许为绝对地址")
	}
	if ref.Fragment != "" || ref.RawFragment != "" {
		return nil, errors.New("请求路径不允许包含锚点")
	}
	if prefix := strings.TrimSuffix(base.EscapedPath(), "/"); prefix != "" && !hasPathPrefix(ref.EscapedPath(), prefix) {
		ref, err = url.Parse(prefix + path)
		if err != nil {
			return nil, errors.New("请求路径非法")
		}
	}
	for _, seg := range strings.Split(ref.Path, "/") {
		if seg == ".." {
			return nil, errors.New("请求路径不允许包含 ..")
		}
	}
	endpoint := base.ResolveReference(ref)
	if !sameOrigin(base, endpoint) {
		return nil, errors.New("请求路径不允许跨域")
	}
	return endpoint, nil
}

// hasPathPrefix 判断路径是否已带 base 前缀（按路径段对齐）。
func hasPathPrefix(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// FilterRequestHeaders 只放行 content-type/accept 以及 `x-` 前缀头；authorization 由 Bridge 注入。
func FilterRequestHeaders(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		name := strings.ToLower(strings.TrimSpace(k))
		value := strings.TrimSpace(v)
		if name == "" || value == "" {
			continue
		}
		if name == "content-type" || name == "accept" || strings.HasPrefix(name, "x-") {
			out[name] = value
		}
	}
	return out
}

// FilterResponseHeaders 过滤 set-cookie 等敏感/逐跳头，返回可交给前端的响应头。
func FilterResponseHeaders(in http.Header) map[string]string {
	out := make(map[string]string, len(in))
	for k, values := range in {
		name := strings.ToLower(k)
		if hopByHopHeaders[name] {
			continue
		}
		joined := strings.TrimSpace(strings.Join(values, ", "))
		if joined == "" {
			continue
		}
		out[name] = joined
	}
	return out
}

// parseBaseURL 校验并解析服务地址：只允许 http/https，无 userinfo/fragment。
func parseBaseURL(raw string) (*url.URL, error) {
	normalized, err := platform.ValidateExternalURL(raw)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(normalized)
	if err != nil {
		return nil, errors.New("服务地址非法")
	}
	return u, nil
}

// sameOrigin 比较 scheme/host/port（端口按协议默认值补齐）。
func sameOrigin(a, b *url.URL) bool {
	if a == nil || b == nil {
		return false
	}
	if !strings.EqualFold(a.Scheme, b.Scheme) {
		return false
	}
	if !strings.EqualFold(a.Hostname(), b.Hostname()) {
		return false
	}
	return effectivePort(a) == effectivePort(b)
}

func effectivePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	}
	return ""
}
