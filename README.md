# MyAIUI2

面向 Windows 内网环境的轻量本地 AI 对话桌面应用（原型）。

- 技术栈：Wails v2.16（Go 1.26）+ React 19 + TypeScript + Vite 8 + Vercel AI SDK 6 + SQLite（modernc，纯 Go）+ Windows DPAPI。
- 方案与范围：[实施方案与任务拆解](docs/IMPLEMENTATION_PLAN.md)、[人工冒烟清单](docs/MANUAL_SMOKE_TEST.md)、[上游复用台账](docs/UPSTREAM_REUSE.md)。

## 已确定的产品边界

- 只保留对话工作台；设置使用抽屉或弹窗，不增加独立业务页面。
- 支持添加助手、新建话题、配置模型服务、同步模型、纯文字对话、联网搜索（SearXNG）、展示模型返回的图片；消息内代码块带语法高亮（highlight.js，配色走本项目 token）并可一键复制。
- 支持会话内分支：重新生成/编辑重发产生兄弟版本（消息上 `‹ n/m ›` 切换），「分支」面板可查看整棵消息树并回退到任意节点；话题可「复制为新会话」，对话可「导出为 Markdown」（复制到剪贴板或另存为 .md）。
- 禁止文件选择、文件拖放、文件/图片粘贴、附件上传、文档处理、知识库、MCP、智能体、频道、应用、OpenClaw 和 API Server。
  - 唯一例外：「导出为 Markdown → 另存为 .md 文件」是用户显式批准的文件写入点，目标路径由用户在系统保存对话框中选择，正文始终由 Go 侧重新生成（方案 §24.1）。
- Go/Wails 只负责桌面壳、本地持久化、密钥保护与受限网络传输；模型协议与消息编排位于 React 前端的 Vercel AI SDK 适配层。

## 开发

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0   # 仅首次
pnpm --dir frontend install
wails dev                                                    # 热重载开发
wails build -clean -trimpath -platform windows/amd64         # 交付构建
```

质量守门（原型阶段不写单测）：

```powershell
go vet ./...
pnpm --dir frontend typecheck
```

人工冒烟可用本地假模型服务（`/v1/models`、流式 `/v1/chat/completions`、`/v1/images/generations`）：

```powershell
python temp/fake_provider.py 8791     # 然后在应用里把模型服务地址填成 http://127.0.0.1:8791/v1
```

## 运行期数据

- 数据库与设置：`%LOCALAPPDATA%\MyAIUI2\data\app.db`（WAL）。
- API Key：Windows DPAPI 加密后入库，前端只能看到「已配置」。

## 参考项目

Cherry Studio：`D:\WorkProject\3rd_github\Group_cli_agent\cherry-studio`，基线提交 `f236b74929f1683a23b3a808f57e5a9d53f0b1e8`（AGPL-3.0）。仅复用视觉数值与交互语言，登记见 `docs/UPSTREAM_REUSE.md`。
