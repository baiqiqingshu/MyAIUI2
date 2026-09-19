// 本文件是本应用唯一允许写入用户文件的代码路径。
// 目标路径完全由用户在系统保存对话框中选择：前端只能提供建议文件名（已清洗），
// 不能指定目录，也不能提交任意文件内容——Markdown 始终由 Go 侧根据话题重新渲染。

package api

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// SaveTopicMarkdown 弹出系统保存对话框，并把话题的当前分支导出为 .md 文件。
// fileName 仅作为建议文件名（会被清洗）；用户取消对话框时返回 Saved=false 且不报错。
func (a *AppAPI) SaveTopicMarkdown(topicID string, fileName string) (SaveMarkdownResultDTO, error) {
	// 正文始终由 Go 侧重新生成，绝不接受前端传入的内容。
	export, err := a.ExportTopicMarkdown(topicID)
	if err != nil {
		return SaveMarkdownResultDTO{}, err
	}
	name := sanitizeExportName(fileName)
	if name == "" {
		name = export.FileName
	}
	if !strings.HasSuffix(strings.ToLower(name), ".md") {
		name += ".md"
	}

	ctx := a.wailsContext()
	if ctx == nil {
		return SaveMarkdownResultDTO{}, errors.New("应用尚未初始化")
	}
	path, err := runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{
		Title:                "导出为 Markdown",
		DefaultFilename:      name,
		Filters:              []runtime.FileFilter{{DisplayName: "Markdown 文件", Pattern: "*.md"}},
		CanCreateDirectories: true,
	})
	if err != nil {
		return SaveMarkdownResultDTO{}, wrapRepoErr("打开保存对话框失败", "", err)
	}
	if strings.TrimSpace(path) == "" {
		return SaveMarkdownResultDTO{Saved: false, FileName: name}, nil
	}
	if err := os.WriteFile(path, []byte(export.Markdown), 0o644); err != nil {
		return SaveMarkdownResultDTO{}, wrapRepoErr("写入 Markdown 文件失败", "", err)
	}
	// 只回传文件名，避免把本机路径泄漏给渲染层。
	return SaveMarkdownResultDTO{Saved: true, FileName: filepath.Base(path)}, nil
}
