// Package logging 提供脱敏日志。
//
// 只输出到 stderr，前缀 [myaiui2]；任何日志文本都会经过 Redact，
// 调用方仍然禁止记录 Prompt、消息正文、Authorization 和完整 URL query。
package logging

import (
	"fmt"
	"log"
	"os"
	"regexp"
)

var std = log.New(os.Stderr, "[myaiui2] ", log.LstdFlags)

// Infof 输出信息日志（已脱敏）。
func Infof(format string, args ...any) { std.Println(Redact(fmt.Sprintf(format, args...))) }

// Errorf 输出错误日志（已脱敏）。
func Errorf(format string, args ...any) { std.Println(Redact(fmt.Sprintf(format, args...))) }

var (
	// Bearer <token>
	reBearer = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]+`)
	// authorization: xxx / api_key=xxx / token=xxx 等敏感键值
	reSecretKV = regexp.MustCompile(`(?i)\b(authorization|api[_-]?key|apikey|access[_-]?token|secret)\b\s*["']?\s*[:=]\s*["']?[^\s"'&,;)\]]+`)
	// OpenAI 风格密钥
	reOpenAIKey = regexp.MustCompile(`\bsk-[A-Za-z0-9_\-]{4,}`)
	// URL query 值：仅匹配 ? 或 & 之后的键值对
	reURLQueryValue = regexp.MustCompile(`([?&][A-Za-z0-9_\-\.\[\]%]+=)[^&\s"'#]*`)
	// 长 base64 串（可能是密钥或模型输入）
	reLongBase64 = regexp.MustCompile(`[A-Za-z0-9+/]{40,}={0,2}`)
)

// Redact 去除 Bearer/Authorization/API key 形态、URL query 值与长 base64。
func Redact(s string) string {
	if s == "" {
		return s
	}
	out := reBearer.ReplaceAllString(s, "Bearer ***")
	out = reSecretKV.ReplaceAllString(out, "${1}=***")
	out = reOpenAIKey.ReplaceAllString(out, "sk-***")
	out = reURLQueryValue.ReplaceAllString(out, "${1}***")
	out = reLongBase64.ReplaceAllString(out, "***")
	return out
}
