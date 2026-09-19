# 第三方组件与许可声明

本文件登记 MyAIUI2 原型中使用/参考的第三方内容。产品自身按 GNU AGPL-3.0 分发（见 `LICENSE`）。

## 1. 运行时依赖（前端）

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| react / react-dom | 19.3.0 | MIT | UI 运行时 |
| ai（Vercel AI SDK Core） | 6.0.286 | Apache-2.0 | 文本流式对话、模型抽象 |
| @ai-sdk/openai-compatible | 2.0.75 | Apache-2.0 | OpenAI Compatible Provider |
| zustand | 5.0.15 | MIT | 瞬时 UI 状态 |
| zod | 4.6.5 | MIT | 外部数据边界校验（消息片段/持久化 JSON） |
| react-markdown | 10.1.0 | MIT | Markdown 渲染（不启用原始 HTML） |
| remark-gfm | 4.0.1 | MIT | GFM 扩展 |
| lucide-react | 1.47.0 | ISC | 图标 |
| clsx | 2.1.1 | MIT | className 组合 |

开发依赖：vite 8.3.0（MIT）、@vitejs/plugin-react 6.1.1（MIT）、typescript 5.9.3（Apache-2.0）、@types/react(-dom) 19.3.0（MIT）。

## 2. 运行时依赖（Go）

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| github.com/wailsapp/wails/v2 | v2.16.0 | MIT | Windows 桌面壳、绑定与事件 |
| modernc.org/sqlite | v1.59.0 | BSD-3-Clause | 纯 Go SQLite 驱动 |

Go 标准库（`crypto/rand`、`net/http`、`syscall` 等）按 Go 许可（BSD-3-Clause）。
Windows DPAPI 通过 `crypt32.dll` / `kernel32.dll` 的 syscall 调用实现，未引入第三方封装包。

## 3. 视觉与结构参考（Cherry Studio）

参考工程：`D:\WorkProject\3rd_github\Group_cli_agent\cherry-studio`，提交 `f236b74929f1683a23b3a808f57e5a9d53f0b1e8`，许可 AGPL-3.0。

- 迁移内容：设计 Token 的语义色/圆角/阴影数值、三栏布局比例、滚动条与消息排版风格。
- 未迁移：Cherry 名称、Logo、应用图标等品牌资产；Electron 主进程/预加载、Redux/Dexie 数据层、Agent/MCP/知识库/文件相关组件与业务代码。
- 逐文件登记见 `docs/UPSTREAM_REUSE.md`。

## 4. 明确不包含

无遥测、无崩溃上报（Sentry 等）、无自动更新、无第三方 CDN、无远程字体、无 Web 服务器框架、无 MCP/Agent/向量数据库/对象存储依赖。本应用不监听任何本地端口。
