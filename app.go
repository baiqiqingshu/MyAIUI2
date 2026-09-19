package main

import (
	"context"
	"log"

	"myaiui2/internal/api"
)

// App 只承担 Wails 生命周期：把启动/关闭时机转交给 api.AppAPI。
// 业务方法一律在 AppAPI 上，前端也只绑定 AppAPI。
type App struct {
	api *api.AppAPI
}

func NewApp() *App {
	return &App{api: api.NewAppAPI()}
}

func (a *App) Startup(ctx context.Context) {
	if err := a.api.Start(ctx); err != nil {
		log.Printf("[myaiui2] 启动初始化失败: %v", err)
	}
}

func (a *App) Shutdown(ctx context.Context) {
	a.api.Stop(ctx)
}
