package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		// 窗口标题 = 产物/进程名：任务管理器对窗口进程显示的「应用名」取自窗口标题，
		// 若这里保留旧名，展开进程树时会看到一个与 asina_myaiui 不一致的条目。
		Title:       "asina_myaiui",
		Width:       1280,
		Height:      820,
		MinWidth:    940,
		MinHeight:   620,
		AssetServer: &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 24, G: 24, B: 27, A: 255},
		OnStartup:   app.Startup,
		OnShutdown:  app.Shutdown,
		Bind:        []interface{}{app.api},
		// 单实例：内网桌面工具，避免同库并发写。
		// UniqueId 与产物名 asina_myaiui 保持一致：旧版本（MyAIUI2.exe）与新版本可并存，
		// 部署时不会因为换了进程名而互相抢占。
		SingleInstanceLock: &options.SingleInstanceLock{UniqueId: "asina_myaiui-single-instance-v1"},
		// 安全基线：关闭文件拖放与 WebView 拖放，关闭生产环境默认右键菜单。
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     false,
			DisableWebViewDrop: true,
		},
		EnableDefaultContextMenu:         false,
		EnableFraudulentWebsiteDetection: false,
		Windows: &windows.Options{
			WebviewUserDataPath: "",
			Theme:               windows.SystemDefault,
		},
		Debug: options.Debug{
			OpenInspectorOnStartup: false,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
