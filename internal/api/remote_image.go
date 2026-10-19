package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"myaiui2/internal/transport"
)

// LoadRemoteImage loads only an image referenced by a persisted message. Using
// the shared bridge keeps image downloads on the configured proxy/relay route.
func (a *AppAPI) LoadRemoteImage(messageID, imageURL string) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	if err := validateUUID("消息 ID", messageID); err != nil {
		return "", err
	}
	message, err := a.messages.Get(messageID)
	if err != nil {
		return "", wrapRepoErr("读取消息失败", "消息不存在", err)
	}
	var parts []struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	if err := json.Unmarshal([]byte(message.PartsJSON), &parts); err != nil {
		return "", errors.New("消息图片数据无效")
	}
	found := false
	for _, part := range parts {
		if part.Type == "image" && part.URL == imageURL && imageURL != "" {
			found = true
			break
		}
	}
	if !found {
		return "", errors.New("图片地址不属于此消息")
	}
	// Signed image links can exceed the shorter limit for user-entered links.
	if len(imageURL) > 16<<10 {
		return "", errors.New("图片地址过长")
	}
	u, err := url.Parse(imageURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" ||
		(u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("图片地址无效")
	}
	const timeout = 60 * time.Second
	response, err := a.collect(transport.Request{
		ID:      uuid.NewString(),
		Method:  http.MethodGet,
		Path:    u.RequestURI(),
		Headers: map[string]string{"accept": "image/*"},
		Timeout: timeout,
	}, transport.Target{ID: "message-image", BaseURL: u.Scheme + "://" + u.Host}, timeout)
	if err != nil {
		return "", err
	}
	if response.status < 200 || response.status >= 300 {
		return "", fmt.Errorf("图片加载失败（HTTP %d）", response.status)
	}
	// collect enforces the shared 8 MiB limit. Sniff bytes instead of trusting
	// the remote Content-Type; HTML and active SVG documents are never returned.
	mime := http.DetectContentType(response.body)
	if !strings.HasPrefix(mime, "image/") {
		return "", errors.New("远程响应不是支持的图片格式")
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(response.body), nil
}
