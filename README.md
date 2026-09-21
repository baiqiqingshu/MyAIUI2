# MyAIUI2

面向 Windows 内网环境的轻量本地 AI 对话桌面应用（原型）。

- 技术栈：Wails v2.16（Go 1.26）+ React 19 + TypeScript + Vite 8 + Vercel AI SDK 6 + SQLite（modernc，纯 Go）+ Windows DPAPI。
- 方案与范围：[实施方案与任务拆解](docs/IMPLEMENTATION_PLAN.md)、[人工冒烟清单](docs/MANUAL_SMOKE_TEST.md)、[上游复用台账](docs/UPSTREAM_REUSE.md)。

## 已确定的产品边界

- 只保留对话工作台；设置使用抽屉或弹窗，不增加独立业务页面。
- 支持添加助手、新建话题、配置模型服务、同步模型、纯文字对话、联网搜索（SearXNG）、展示模型返回的图片；消息内代码块带语法高亮（highlight.js，配色走本项目 token）并可一键复制，` ```mermaid ` 围栏直接渲染成流程图（mermaid 按需加载）。
- 模型服务支持三种接口协议：`OpenAI 兼容（/chat/completions）`、`OpenAI 原生（/chat/completions）`、`OpenAI Responses（/v1/responses）`。同步到的模型**默认不启用**，需在模型列表中勾选后才会出现在对话的模型选择里；**停用某模型服务后，它名下的模型会立即从对话页与助手设置的模型选择中移除**。
- 会话内分支：重新生成/编辑重发产生兄弟版本（消息上 `‹ n/m ›` 切换），「分支」面板可查看整棵消息树并回退到任意节点；话题可「复制为新会话」，对话可「导出为 Markdown」（复制到剪贴板或另存为 .md）。
- 输入框高度通过拖动输入区上边沿调整（双击复位），不使用原生右下角手柄。
- 禁止文件选择、文件拖放、文件/图片粘贴、附件上传、文档处理、知识库、MCP、智能体、频道、应用、OpenClaw 和 API Server。
  - 唯一例外：「导出为 Markdown → 另存为 .md 文件」是用户显式批准的文件写入点，目标路径由用户在系统保存对话框中选择，正文始终由 Go 侧重新生成（方案 §24.1）。
- Go/Wails 只负责桌面壳、本地持久化、密钥保护与受限网络传输；模型协议与消息编排位于 React 前端的 Vercel AI SDK 适配层。

## 开发

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0   # 仅首次
pnpm --dir frontend install
wails dev                                                    # 热重载开发
wails build -clean -trimpath -platform windows/amd64         # 交付构建 → build/bin/asina_myaiui.exe
```

交付产物的可执行文件名/进程名为 `asina_myaiui.exe`：`wails.json` 的 `outputfilename`、`info.productName`（写入 PE 的 `FileDescription`/`ProductName`）与 `name`（清单 `assemblyIdentity`），以及 `main.go` 的窗口标题，全部为 `asina_myaiui`。窗口标题也要一致，否则 Windows 任务管理器会用窗口标题显示一个旧名条目。运行时子进程只有一个 `msedgewebview2.exe`（WebView2 自身的浏览器进程，任何 WebView2 应用都有）。应用数据目录仍是 `%LOCALAPPDATA%\MyAIUI2\data`，进程标识与数据目录解耦，改名不会导致既有数据丢失。

质量守门（原型阶段不写单测）：

```powershell
go vet ./...
pnpm --dir frontend typecheck
```

人工冒烟可用本地假模型服务（`/v1/models`、流式 `/v1/chat/completions`、流式 `/v1/responses`、`/v1/images/generations`，并提供 `/log` 与 `/reset_log` 用于断言请求路径）：

```powershell
python temp/fake_provider.py 8791     # 然后在应用里把模型服务地址填成 http://127.0.0.1:8791/v1
```

提问里包含「代码」会返回多语言代码块，包含「图」会返回 ` ```mermaid ` 流程图，包含「长文」会走长推理流式路径，便于验证高亮、Mermaid 渲染与流式压力。

## 运行期数据

- 数据库与设置：`%LOCALAPPDATA%\MyAIUI2\data\app.db`（WAL）。C:\\Users\\Administrator\\AppData\\Local\\MyAIUI2\\data\\app.db

- API Key：Windows DPAPI 加密后入库，前端只能看到「已配置」。

## 参考项目

Cherry Studio：`D:\WorkProject\3rd_github\Group_cli_agent\cherry-studio`，基线提交 `f236b74929f1683a23b3a808f57e5a9d53f0b1e8`（AGPL-3.0）。仅复用视觉数值与交互语言，登记见 `docs/UPSTREAM_REUSE.md`。
