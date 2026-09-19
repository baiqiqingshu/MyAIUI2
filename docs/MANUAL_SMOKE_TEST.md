# 人工冒烟清单（P0 原型）

原型阶段不建设自动化测试；以下清单必须在交付前人工全部通过（方案 §17）。

## 0. 本次执行记录（2026-09-19，原型交付验证）

执行环境：Windows 11，`wails dev`（浏览器标签 + 真实 Wails 绑定/事件）+ 本地 OpenAI 兼容假服务端
（`/v1/models`、SSE `/v1/chat/completions`、`/v1/images/generations`、`/search`）+ 发布构建
`build/bin/MyAIUI2.exe`。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 创建模型服务并同步模型 | 通过 | 「连接成功：延迟 2ms，发现 3 个模型」；「同步完成：新增 3 / 更新 0 / 失联 0」；`dall-e-3` 自动判定为 `image` |
| 手动添加模型 / 模型启停 / modality 修正 | 通过 | 界面操作 + `models` 表落库 |
| 助手增删改切换 | 通过 | 新建（助手已创建）/ 悬停头像铅笔编辑（预填名称、提示词、模型、温度 0.7）/ 删除（助手已删除） |
| 话题新建、重命名、删除、切换 | 通过 | 新建后自动选中；重命名 Enter 提交；删除有二次确认弹窗 |
| 纯文本输入 + 多轮对话 | 通过 | 4 轮对话；假服务端日志显示 messages 数递增（3 → 4 → 7），历史正确携带 |
| 流式渲染 / 停止 / 重新生成 / 复制 | 通过 | 逐块渲染 Markdown 与代码块；停止后消息标记「已停止」且数据库 `status=cancelled`；重新生成替换末轮回答；复制写入剪贴板 |
| 重启后数据仍在 | 通过 | 页面重载后助手、话题、消息、模型选择全部恢复（`Bootstrap` 读 SQLite） |
| 联网搜索开关 | 通过 | 关闭时无 `/search` 请求；开启时出现引用卡（标题/URL/摘要）并在输入器提示「本次提问会发送到你配置的搜索服务」 |
| 图片模型输出 | 通过 | `dall-e-3` + 纯文本 Prompt → `/v1/images/generations` → `<img src="data:image/png;base64,…" referrerpolicy="no-referrer">` |
| API Key 不泄露 | 通过 | 前端只显示「已配置」；`app.db` 与 `app.db-wal` 中 grep 不到密钥明文；假服务端收到 `Authorization: Bearer <真实密钥>`（证明由 Go 注入） |
| 文件拖放 / 粘贴拦截 | 通过 | 合成 `drop`/`dragover`（携带 File）均被 `preventDefault`，URL 未变化；粘贴守卫仅拦截文件/图片 |
| Release 不监听端口 | 通过 | 运行中的 `MyAIUI2.exe` 无任何 LISTEN 端口；进程 34MB，窗口正常渲染首屏引导 |
| 关键词审计 | 通过 | Go/前端源码中 `dialog/OpenFile/ReadFile/exec/Listen/MCP/Agent/telemetry/sentry/analytics/updater/electron/localStorage/fetch(` 命中均为「声明禁止」的注释，无实际能力 |

## 1. 前置

```powershell
pnpm --dir frontend install
wails dev            # 开发验证
wails build -clean -trimpath -platform windows/amd64   # 交付构建
```

数据目录：`%LOCALAPPDATA%\MyAIUI2\data`（`app.db`）。

## 2. 核心功能

- [x] 新安装后能创建第一个模型服务并同步模型。
- [x] `/models` 不可用时能手工添加模型。
- [x] 能添加助手，并设置系统提示词与默认模型。
- [x] 能在助手下新建、重命名、删除、切换话题。
- [x] 只能输入/粘贴纯文字，可连续多轮对话。
- [x] 可以停止生成、重新生成、复制文本。
- [x] 重启应用后助手、话题、消息、模型配置仍在。
- [x] 打开联网开关后能显示搜索来源；关闭时无搜索请求。
- [x] 选择图片模型后，纯文本 Prompt 能返回并显示图片。

## 3. 文件隔离

- [x] 界面中没有打开、保存、导入、导出、附件、上传入口。
- [x] 拖入本地文件不会打开、读取或显示路径。
- [x] 粘贴图片/文件被拒绝，纯文字仍可粘贴。
- [x] Wails 生成绑定中没有路径型文件接口（`frontend/wailsjs/go/api/AppAPI.d.ts` 全部为业务方法）。
- [x] 代码中不存在对任意用户路径的 `os.ReadFile`/`os.Open`（schema 走 `//go:embed`）。
- [x] `file:`、UNC、本地路径形式的模型输出不会成为可点击或可渲染资源（外链只走 `OpenExternalURL` 校验）。

## 4. 数据与网络

- [x] 数据库与日志中没有 API Key 明文。
- [x] 日志不含 Prompt、回答正文、Authorization（`internal/logging.Redact` 过滤）。
- [x] Release 不监听任何本地端口。
- [x] 任意 URL 不能借网络桥访问；只有已配置的精确 origin 可用。
- [x] 跨 origin redirect 被拒绝（transport 冒烟覆盖）。
- [x] 无遥测、Sentry、自动更新、云备份与官方中转请求。

## 5. 构建

- [x] `pnpm --dir frontend typecheck` 通过。
- [x] `go vet ./...` 通过。
- [x] `wails build -clean -trimpath -platform windows/amd64` 通过（`build/bin/MyAIUI2.exe`，16.4MB）。
- [ ] 在一台无开发环境的 Windows 内网机器上启动并对接真实模型服务 —— 待部署环境验证。

## 6. 遗留（不影响 P0 主链路）

- 原生窗口截图依赖 PowerShell `PrintWindow`，仅验证了首屏与无监听端口；交互验证在 `wails dev` 的真实绑定会话中完成。
- 温度为「未设置」时请求体不带 `temperature`（与 Cherry 一致）；需要固定采样温度请在助手设置中显式开启。

