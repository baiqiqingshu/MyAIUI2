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
		Title:       "MyAIUI2",
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
		SingleInstanceLock: &options.SingleInstanceLock{UniqueId: "myaiui2-single-instance-v1"},
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
