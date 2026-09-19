/// <reference types="vite/client" />

// Wails 注入的全局对象（v2.16 桌面运行时）。
// 说明：这里手写声明而不是引用 wailsjs 生成产物，保证前端在生成绑定之前也能独立类型检查；
// 形状与 wails 生成代码一致：window.go.<package>.<Struct>.<Method>(...args) -> Promise
export interface WailsRuntime {
  EventsOn(eventName: string, callback: (...data: unknown[]) => void): () => void
  EventsOff(eventName: string): void
  EventsEmit(eventName: string, ...data: unknown[]): void
  BrowserOpenURL(url: string): void
}

export type WailsBinding = (...args: unknown[]) => Promise<unknown>

declare global {
  interface Window {
    go?: {
      api?: {
        AppAPI?: Record<string, WailsBinding>
      }
    }
    runtime?: WailsRuntime
  }
}

export {}
