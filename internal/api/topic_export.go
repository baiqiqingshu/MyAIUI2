package api

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"myaiui2/internal/repository"
)

// exportPart 是 parts_json 中单个片段的只读投影；只需要渲染用得到的字段，
// 未知类型会被忽略而不是报错。
type exportPart struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Source   string `json:"source"`
	MimeType string `json:"mimeType"`
	Code     string `json:"code"`
	Message  string `json:"message"`
}

const (
	exportNameMaxRunes = 60
	exportNameFallback = "对话"
	exportTimeLayout   = "2006-01-02 15:04"
	exportStampLayout  = "20060102-150405"
)

// ExportTopicMarkdown 把话题的当前活动分支渲染成 Markdown 文本。
// 只导出活动路径（不含兄弟变体），助手信息读取失败时退回零值继续导出。
func (a *AppAPI) ExportTopicMarkdown(topicID string) (MarkdownExportDTO, error) {
	if err := a.ready(); err != nil {
		return MarkdownExportDTO{}, err
	}
	id := strings.TrimSpace(topicID)
	if err := validateUUID("话题 ID", id); err != nil {
		return MarkdownExportDTO{}, err
	}
	topic, err := a.topics.Get(id)
	if err != nil {
		return MarkdownExportDTO{}, wrapRepoErr("读取话题失败", "话题不存在", err)
	}
	_, path, err := a.topicAndActivePath(topic.ID)
	if err != nil {
		return MarkdownExportDTO{}, wrapRepoErr("读取话题消息失败", "", err)
	}
	var assistant repository.Assistant
	if topic.AssistantID != "" {
		if found, getErr := a.assistants.Get(topic.AssistantID); getErr == nil {
			assistant = found
		}
	}
	now := time.Now()
	return MarkdownExportDTO{
		TopicID:      topic.ID,
		FileName:     exportFileName(topic.Title, now),
		Markdown:     renderTopicMarkdown(topic, assistant, path, now),
		MessageCount: len(path),
	}, nil
}

// renderTopicMarkdown 渲染导出正文：保留消息原文 Markdown（不做 HTML 转义），
// 只对思考过程、引用、图片、错误这类结构化片段做包装。
func renderTopicMarkdown(topic repository.Topic, assistant repository.Assistant, path []repository.Message, now time.Time) string {
	title := strings.TrimSpace(topic.Title)
	if title == "" {
		title = defaultTopicTitle
	}

	var b strings.Builder
	b.WriteString("# " + title + "\n\n")
	b.WriteString(exportAssistantLine(assistant) + "\n")
	b.WriteString("- 导出时间：" + now.Format(exportTimeLayout) + "\n")
	fmt.Fprintf(&b, "- 消息数：%d（当前分支）\n", len(path))

	for _, message := range path {
		b.WriteString("\n---\n\n")
		b.WriteString("### " + exportRoleLabel(message.Role) + "\n\n")
		segments := make([]string, 0, 2)
		if body := renderExportMessageParts(message.PartsJSON); body != "" {
			segments = append(segments, body)
		}
		if note := exportStatusNote(message.Status); note != "" {
			segments = append(segments, note)
		}
		b.WriteString(strings.Join(segments, "\n\n"))
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}

// exportAssistantLine 生成助手信息行；助手缺失（ID 或名称为空）时退回默认助手的写法。
func exportAssistantLine(assistant repository.Assistant) string {
	name := strings.TrimSpace(assistant.Name)
	emoji := strings.TrimSpace(assistant.Emoji)
	// icon:<名>:<色> 是前端头像规格，不是可打印字符，导出时略去。
	if strings.HasPrefix(emoji, "icon:") {
		emoji = ""
	}
	if assistant.ID == "" || name == "" {
		return "- 助手：" + defaultAssistantName
	}
	if emoji == "" {
		return "- 助手：" + name
	}
	return "- 助手：" + emoji + " " + name
}

// renderExportMessageParts 按顺序拼装消息片段；parts_json 解析失败或超限时按空内容处理，
// 绝不让一条脏数据打断整篇导出。
func renderExportMessageParts(partsJSON string) string {
	raw := strings.TrimSpace(partsJSON)
	if raw == "" || len(raw) > maxPartsBytes {
		return ""
	}
	var parts []exportPart
	if err := json.Unmarshal([]byte(raw), &parts); err != nil {
		return ""
	}

	blocks := make([]string, 0, len(parts))
	searchIndex := -1
	for _, part := range parts {
		switch part.Type {
		case "text":
			if text := normalizeExportText(part.Text); text != "" {
				blocks = append(blocks, text)
			}
		case "reasoning":
			if text := normalizeExportText(part.Text); text != "" {
				blocks = append(blocks, "<details>\n<summary>思考过程</summary>\n\n"+text+"\n\n</details>")
			}
		case "search-result":
			// 同一条消息里的多个引用合并成一个列表，列表中每行一条。
			line := fmt.Sprintf("- [%s](%s)", part.Title, part.URL)
			if searchIndex < 0 {
				searchIndex = len(blocks)
				blocks = append(blocks, line)
			} else {
				blocks[searchIndex] += "\n" + line
			}
		case "image":
			blocks = append(blocks, renderExportImagePart(part))
		case "error":
			blocks = append(blocks, fmt.Sprintf("> ⚠️ 生成失败：%s（%s）", part.Message, part.Code))
		}
	}
	return strings.TrimSpace(strings.Join(blocks, "\n\n"))
}

// renderExportImagePart：远程 https 图片可以直接内联；生成图或非 https 图只留提示行，
// 避免把 base64 数据或不可信协议写进 Markdown。
func renderExportImagePart(part exportPart) string {
	url := strings.TrimSpace(part.URL)
	if part.Source == "remote" && strings.HasPrefix(url, "https://") {
		return "![图片](" + url + ")"
	}
	return fmt.Sprintf("> [图片输出：%s]（Markdown 导出不包含图片数据）", part.MimeType)
}

// exportStatusNote 为未完成的回复补一行说明，读者不必猜测为什么正文戛然而止。
func exportStatusNote(status string) string {
	switch status {
	case "cancelled":
		return "> 该回复已停止生成"
	case "interrupted":
		return "> 该回复因应用重启被中断"
	case "streaming", "pending":
		return "> 该回复未完成"
	default:
		return ""
	}
}

func exportRoleLabel(role string) string {
	switch role {
	case "assistant":
		return "助手"
	case "user":
		return "用户"
	default:
		return "消息"
	}
}

// normalizeExportText 统一换行为 \n 并去掉首尾空白，保持正文自身的 Markdown 结构。
func normalizeExportText(text string) string {
	return strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
}

// exportFileName 生成建议文件名：清洗后的标题 + 时间戳 + .md，结果不含任何路径成分。
func exportFileName(title string, now time.Time) string {
	name := sanitizeExportName(title)
	if name == "" {
		name = exportNameFallback
	}
	return name + "-" + now.Format(exportStampLayout) + ".md"
}

// sanitizeExportName 把用户可控文本压成安全的文件名片段：剥离路径分隔符、控制字符与
// `..`，折叠空白，去掉首尾点/空格并截断长度。空结果表示无法生成有效名称。
func sanitizeExportName(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		// 空白类控制字符交给 Fields 折叠，其余控制字符直接丢弃。
		if r == 0x7f || (r < 0x20 && !unicode.IsSpace(r)) {
			continue
		}
		switch r {
		case '\\', '/', ':', '*', '?', '"', '<', '>', '|':
			continue
		}
		b.WriteRune(r)
	}
	cleaned := strings.Join(strings.Fields(b.String()), " ")
	// 先去掉所有 `..`，再裁首尾点号：确保不会拼出 `.`、`..` 或以点结尾的非法名。
	cleaned = strings.ReplaceAll(cleaned, "..", "")
	cleaned = strings.Trim(cleaned, ". ")
	if utf8.RuneCountInString(cleaned) > exportNameMaxRunes {
		cleaned = string([]rune(cleaned)[:exportNameMaxRunes])
	}
	return strings.Trim(cleaned, ". ")
}
