package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// 契约 §2.7 的长度与大小上限（字符数按 rune 计，字节数按 byte 计）。
const (
	maxNameLen     = 80
	maxTitleLen    = 120
	maxPromptLen   = 8000
	maxMessageLen  = 32000
	maxRemoteIDLen = 200
	maxURLLen      = 2048
	maxPartsBytes  = 256 * 1024
	maxPathLen     = 1024
)

// 枚举白名单：未知取值一律拒绝，避免脏数据落库。
var (
	providerKinds  = enumSet("openai-compatible")
	modalities     = enumSet("text", "image")
	roles          = enumSet("user", "assistant")
	messageStatus  = enumSet("pending", "streaming", "done", "cancelled", "error", "interrupted")
	finalStatus    = enumSet("done", "cancelled", "error")
	themes         = enumSet("system", "light", "dark")
	searchServices = enumSet("searxng")
)

func enumSet(values ...string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, v := range values {
		set[v] = struct{}{}
	}
	return set
}

// validateUUID 校验 ID：必须是标准 UUID v4（uuid.Parse 同时排除了路径分隔符等非法字符）。
func validateUUID(field, id string) error {
	value := strings.TrimSpace(id)
	if value == "" {
		return fmt.Errorf("%s不能为空", field)
	}
	if len(value) > 64 {
		return fmt.Errorf("%s格式非法", field)
	}
	parsed, err := uuid.Parse(value)
	if err != nil {
		return fmt.Errorf("%s格式非法", field)
	}
	if parsed.Version() != 4 {
		return fmt.Errorf("%s必须是 UUID v4", field)
	}
	return nil
}

// validateTextLen 按字符数校验长度上限。
func validateTextLen(field, value string, max int) error {
	if utf8.RuneCountInString(value) > max {
		return fmt.Errorf("%s长度不能超过 %d 个字符", field, max)
	}
	return nil
}

// validateEnum 校验枚举取值。
func validateEnum(field, value string, allowed map[string]struct{}) error {
	if _, ok := allowed[value]; !ok {
		return fmt.Errorf("%s取值非法", field)
	}
	return nil
}

// normalizeBaseURL 规范化服务地址：只允许 http/https、禁止 userinfo 与 fragment，并去掉路径尾部 `/`。
func normalizeBaseURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", errors.New("服务地址不能为空")
	}
	if utf8.RuneCountInString(value) > maxURLLen {
		return "", fmt.Errorf("服务地址长度不能超过 %d 个字符", maxURLLen)
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", errors.New("服务地址格式非法")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("服务地址只允许 http/https")
	}
	if parsed.User != nil {
		return "", errors.New("服务地址不能包含用户名或密码")
	}
	if parsed.Fragment != "" {
		return "", errors.New("服务地址不能包含 # 片段")
	}
	if parsed.Host == "" {
		return "", errors.New("服务地址缺少主机名")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed.String(), nil
}

// validateRelativePath 校验网络桥路径：必须以 `/` 开头，且不能携带 scheme/host 或 `..`。
func validateRelativePath(field, path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("%s不能为空", field)
	}
	if utf8.RuneCountInString(path) > maxPathLen {
		return fmt.Errorf("%s长度不能超过 %d 个字符", field, maxPathLen)
	}
	if strings.HasPrefix(path, "//") {
		return fmt.Errorf("%s不能以 // 开头", field)
	}
	if strings.Contains(path, "://") {
		return fmt.Errorf("%s必须是相对路径", field)
	}
	if !strings.HasPrefix(path, "/") {
		return fmt.Errorf("%s必须以 / 开头", field)
	}
	if strings.Contains(path, "..") {
		return fmt.Errorf("%s不能包含 ..", field)
	}
	return nil
}

// validatePartsJSON 校验消息片段：必须是 JSON 数组，且不超过 256KB。
func validatePartsJSON(field, raw string) error {
	value := strings.TrimSpace(raw)
	if value == "" {
		return fmt.Errorf("%s不能为空", field)
	}
	if len(raw) > maxPartsBytes {
		return fmt.Errorf("%s不能超过 256KB", field)
	}
	if value == "null" {
		return fmt.Errorf("%s必须是 JSON 数组", field)
	}
	var parts []json.RawMessage
	if err := json.Unmarshal([]byte(value), &parts); err != nil {
		return fmt.Errorf("%s必须是 JSON 数组", field)
	}
	return nil
}

// ensureLeadingSlash 把相对路径补成以 `/` 开头的形式。
func ensureLeadingSlash(path string) string {
	if path == "" || strings.HasPrefix(path, "/") {
		return path
	}
	return "/" + path
}
