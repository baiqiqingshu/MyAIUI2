package transport

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// proxyTransport 是不可变配置快照；保存设置不会改写正在使用的 Transport。
type proxyTransport struct {
	url string
	rt  *http.Transport
}

// NormalizeProxyURL 支持 HTTP 正向代理，HTTP/HTTPS 目标共用该代理。
// 空地址禁用代理；有意不读取环境变量或 NO_PROXY。
func NormalizeProxyURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	invalid := errors.New("代理地址格式错误，请填写 http://主机:端口，可包含用户名和密码")
	if len(raw) > 4096 || strings.ContainsAny(raw, "\r\n\t") {
		return "", invalid
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Hostname() == "" || u.Opaque != "" {
		return "", invalid
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") {
		return "", invalid
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", invalid
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", invalid
		}
	}
	u.Path = ""
	u.RawPath = ""
	return u.String(), nil
}

// SetProxy 即时替换后续请求的代理配置，已有请求使用原快照继续完成。
func (b *Bridge) SetProxy(raw string) error {
	normalized, err := NormalizeProxyURL(raw)
	if err != nil {
		return err
	}
	var next *proxyTransport
	if normalized != "" {
		u, _ := url.Parse(normalized)
		rt := b.rt.Clone()
		rt.Proxy = http.ProxyURL(u)
		next = &proxyTransport{url: normalized, rt: rt}
	}
	if old := b.proxy.Swap(next); old != nil {
		old.rt.CloseIdleConnections()
	}
	b.rt.CloseIdleConnections()
	return nil
}

func (b *Bridge) outboundTransport(relayAddr string) (*http.Transport, string) {
	if config := b.proxy.Load(); config != nil {
		if relayAddr != "" {
			// 仅 Go→本机中转这一跳直连；由 Python 将真实目标发到代理。
			return b.rt, config.url
		}
		return config.rt, ""
	}
	return b.rt, ""
}
