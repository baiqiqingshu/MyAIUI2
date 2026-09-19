// Package platform 提供平台相关的安全校验。
package platform

import (
	"errors"
	"net/url"
	"strings"
)

// maxURLLength 与 validation.go 的 URL 长度上限保持一致。
const maxURLLength = 2048

// ValidateExternalURL 只放行 http/https，且禁止 userinfo/fragment；返回规范化 URL。
func ValidateExternalURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("链接不能为空")
	}
	if len(raw) > maxURLLength {
		return "", errors.New("链接过长")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("链接格式非法")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("只允许 http/https 链接")
	}
	if u.User != nil {
		return "", errors.New("链接不允许包含用户信息")
	}
	if u.Fragment != "" || u.RawFragment != "" {
		return "", errors.New("链接不允许包含锚点")
	}
	if u.Host == "" || u.Hostname() == "" {
		return "", errors.New("链接缺少主机名")
	}
	u.Scheme = scheme
	return u.String(), nil
}
