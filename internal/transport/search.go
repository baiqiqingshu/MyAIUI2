package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"myaiui2/internal/platform"
)

// 搜索请求限制。
const (
	searchTimeout      = 15 * time.Second
	maxSearchBytes     = 4 << 20
	searchPath         = "/search"
	defaultSearchLimit = 5
	maxSearchLimit     = 10
)

// SearchItem 规范化后的单条搜索结果。
type SearchItem struct {
	Title   string
	URL     string
	Snippet string
	Engine  string
}

// searxngResponse 只取需要的字段，容忍其他扩展字段。
type searxngResponse struct {
	Results []struct {
		Title   string `json:"title"`
		URL     string `json:"url"`
		Content string `json:"content"`
		Engine  string `json:"engine"`
	} `json:"results"`
}

// SearchSearxng 调用 {BaseURL}/search?q=..&format=json&language=zh-CN 并规范化结果；超时 15s。
func (b *Bridge) SearchSearxng(ctx context.Context, target Target, query string, limit int) ([]SearchItem, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errors.New("搜索关键词不能为空")
	}
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxSearchLimit {
		limit = maxSearchLimit
	}

	endpoint, err := ResolveEndpoint(target.BaseURL, searchPath)
	if err != nil {
		return nil, err
	}
	values := endpoint.Query()
	values.Set("q", query)
	values.Set("format", "json")
	values.Set("language", "zh-CN")
	endpoint.RawQuery = values.Encode()

	ctx, cancel := context.WithTimeout(ctx, searchTimeout)
	defer cancel()

	hreq, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, errors.New("搜索请求构造失败")
	}
	hreq.Header.Set("Accept", "application/json")
	if target.APIKey != "" {
		hreq.Header.Set("Authorization", "Bearer "+target.APIKey)
	}

	client := &http.Client{
		Transport:     b.rt,
		CheckRedirect: b.checkRedirect(endpoint),
	}
	resp, err := client.Do(hreq)
	if err != nil {
		return nil, errors.New(sanitizeMessage(searchErrorText(err)))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("搜索服务返回状态码 %d", resp.StatusCode)
	}
	raw, err := readLimited(resp.Body, maxSearchBytes)
	if err != nil {
		return nil, err
	}

	var parsed searxngResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, errors.New("搜索服务返回的数据无法解析")
	}

	items := make([]SearchItem, 0, limit)
	for _, result := range parsed.Results {
		if len(items) >= limit {
			break
		}
		link, err := platform.ValidateExternalURL(strings.TrimSpace(result.URL))
		if err != nil {
			continue // 只保留 http/https 结果
		}
		title := strings.TrimSpace(result.Title)
		if title == "" {
			title = link
		}
		items = append(items, SearchItem{
			Title:   title,
			URL:     link,
			Snippet: strings.TrimSpace(result.Content),
			Engine:  strings.TrimSpace(result.Engine),
		})
	}
	return items, nil
}

// searchErrorText 摘掉 url.Error 包装，避免错误文本里带出完整地址。
func searchErrorText(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		return urlErr.Err.Error()
	}
	return err.Error()
}

// readLimited 读取响应体，超过上限时报错。
func readLimited(r io.Reader, max int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, errors.New("读取搜索响应失败")
	}
	if int64(len(data)) > max {
		return nil, errors.New("搜索响应内容过大")
	}
	return data, nil
}
