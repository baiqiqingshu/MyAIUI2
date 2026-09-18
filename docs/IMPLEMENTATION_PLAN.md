# MyAIUI2 快速原型实施方案

文档状态：可执行草案

编写日期：2026-09-19

目标目录：`D:\WorkProject\MyAIUI2`

参考源码（实际路径）：`D:\WorkProject\3rd_github\Group_cli_agent\cherry-studio`

参考提交：`f236b74929f1683a23b3a808f57e5a9d53f0b1e8`

## 1. 结论摘要

本项目不应从 Cherry Studio 当前 Electron 工程复制一份后逐项删除。参考工程的对话页、消息渲染、输入器、数据层和 Electron IPC 已高度耦合：仅 `src/renderer/components/chat` 就约 8.3 万行，`composer` 约 4.6 万行，Provider Settings 约 3.1 万行。直接删模块会长期承担 Agent、MCP、文件、知识库、迁移系统等残余依赖，原型反而更慢。

建议采用“干净新建 + 选择性视觉迁移”路线：

1. 用稳定版 Wails v2 + Go 创建新的 Windows 桌面壳。
2. 用 React 19 + TypeScript + Vite 重建单一对话工作台。
3. 复用 Cherry Studio 的界面结构、颜色变量、间距、交互习惯和少量低耦合展示组件；不迁移 Electron、Redux/Dexie、IPC、复杂 Composer、Agent/Tool 渲染和数据库迁移代码。
4. Vercel AI SDK 放在前端，负责模型适配、请求体构造、响应解析与流式消息状态。
5. Go 后端保持“薄”：只做固定应用目录内的数据维护、API Key 加密、Wails 启动，以及为解决 CORS/密钥暴露而提供受限的通用 HTTP 传输桥。Go 层不理解 Prompt、Assistant 或具体模型协议。
6. 第一版只实现最短闭环，不写自动化测试；保留类型检查、构建检查和一份人工冒烟清单。

预计单人开发：3 天得到能聊天的内部演示版，5～7 个工作日完成本文 P0 原型范围。

## 2. 需求解释与默认假设

### 2.1 “不能访问任何电脑上的文件”的可实现定义

应用若要保存助手、话题、模型配置和聊天记录，操作系统进程必须读写自身的数据文件。因此本文将该要求解释为：

- 不提供任何读取、选择、扫描、拖入、上传、预览或导出用户文件的功能。
- Go 代码只读写编译进程序的前端资源，以及固定应用数据目录中的数据库/密钥数据。
- 前端不接收本地路径；Wails 绑定中不存在任意路径参数，也不存在 `ReadFile`、`WriteFile`、目录枚举或 Shell 执行接口。
- 不包含文件选择器、保存对话到文件、导入/导出、备份、WebDAV、S3、截图、OCR、剪贴板图片读取等能力。

这属于“产品代码能力隔离”，不是 Windows AppContainer 级强制沙箱。Wails 程序仍以当前 Windows 用户权限运行；若安全制度要求即使程序被篡改也无法读取文件，需要另行采用 Windows AppContainer、WDAC 或专用低权限账户部署，这不纳入快速原型。

### 2.2 “仅能粘贴文字”的定义

- 输入区只使用纯文本 `textarea`，不使用富文本编辑器。
- `paste` 事件只取 `text/plain`。
- 剪贴板包含 `Files`、`image/*` 或只有 HTML 而没有纯文本时直接阻止并提示。
- 全窗口阻止文件拖放；Wails 设置 `EnableFileDrop: false` 和 `DisableWebViewDrop: true`。
- 不创建任何 `<input type="file">`、附件按钮或粘贴图片预览。

### 2.3 “能够返回图片”的定义

原型支持两类只读图片输出：

1. 图片模型通过 AI SDK `generateImage` 返回的 base64/二进制结果。
2. 模型响应中经适配器明确标识的 HTTPS 图片结果。

普通 Markdown 中的任意 `<img>` 和 `file:` 路径不渲染，避免本地路径访问和远程追踪像素。图片只能查看，第一版不提供“另存为”、上传、编辑或再次作为输入发送。

### 2.4 首发平台与语言

- 首发平台：Windows 10/11 x64。
- 首发语言：简体中文。
- 不做 macOS/Linux 安装包，但目录和业务代码避免无意义的平台耦合。
- 使用系统 WebView2；内网离线安装环境需要把 WebView2 Runtime 纳入部署前置检查或安装包。

## 3. 原型范围

### 3.1 P0 必须完成

| 模块 | P0 能力 |
| --- | --- |
| 对话页 | 单一工作台、消息列表、停止生成、重新生成、复制文本、Markdown/代码块展示 |
| 助手 | 新增、编辑、删除、切换；名称、Emoji、系统提示词、默认模型、温度、默认联网搜索开关 |
| 话题 | 新建、重命名、删除、切换；按助手归属；保存纯文本消息和图片输出元数据 |
| 模型服务 | 新增、编辑、删除、启停、连通性检测、自动同步模型、手动补充模型 |
| 模型接入 | OpenAI Compatible 为主；保留 OpenAI/Anthropic/Google 原生适配扩展点 |
| 搜索 | 用户显式开关；SearXNG JSON 接口优先；只取搜索结果标题、URL、摘要，不爬正文 |
| 图片 | 可选择图片模型并用纯文本生成图片；对话响应中的结构化图片可展示 |
| 本地数据 | SQLite 保存业务数据；Windows DPAPI 保护 API Key；无云同步、备份、导入导出 |
| 安全 | 无文件入口、无遥测、无自动更新、无 API Server、网络目标受配置白名单约束 |

### 3.2 明确删除/不建设

- MCP 客户端、服务端、市场、配置、MCP 消息块。
- Agent、子智能体、Agent Session、规划、审批、工具循环、终端和代码执行。
- 文件系统、文件预览、附件、截图、OCR、PDF/Office/图片输入、文档处理。
- 知识库、Embedding、向量数据库、RAG、网页抓取与文档索引。
- 数据设置、数据迁移 UI、备份恢复、WebDAV/S3、局域网传输、导入导出。
- 内置 API Server、API Gateway、WebSocket 服务和远程控制。
- Channel、Bot、Telegram/飞书等消息渠道。
- Mini App、应用市场、浏览器、翻译、绘画工作台、笔记、启动台。
- OpenClaw、Claude Agent SDK、DeepSeek Agent 运行时等 Agent 依赖。
- 多窗口、快捷助手、划词助手、悬浮窗、系统全局快捷键。
- 自动更新、崩溃上报、Sentry、埋点、使用统计和任何 Cherry 官方中转服务。
- 第一阶段不做登录、用户体系、多设备同步和团队共享。

### 3.3 P1/P2 延后

- P1：Anthropic/Google 原生模型完整支持、代理配置、更多搜索服务、会话搜索、主题切换。
- P1：消息编辑分支、Token 统计、上下文裁剪、并发请求恢复。
- P2：OS 级强沙箱、企业策略模板、安装包签名、增量更新、完整自动化测试。

## 4. 参考工程审查与复用策略

### 4.1 审查结论

参考项目当前是 Electron + React 19 的大型单体/工作区工程，已包含 AI SDK 6，但其核心聊天 UI 依赖自有数据 API、偏好系统、缓存、路由、复杂消息分块、工具渲染、富文本 Composer 和 Electron IPC。

代表性耦合：

- `HomePage.tsx` 同时依赖数据 API、偏好、缓存、资源目录、Tab、历史记录和命令系统。
- `Topics.tsx` 同时依赖分组、置顶、回收站、分支、图片捕获、快捷入口和多 Tab。
- `ChatComposer.tsx` 同时依赖 MCP、知识库、附件、引用、消息队列、富文本 Token、工具注册表和 Agent 状态。
- `MessagePartsRenderer` 下包含 Agent、MCP、知识库、网页搜索、HTML Artifact 等多种消息块。

因此，直接复制上述组件并“删 import”不是快速路径。

### 4.2 推荐复用层级

| 级别 | 内容 | 策略 |
| --- | --- | --- |
| A：可直接参考/迁移 | CSS 色值、间距、圆角、阴影、滚动条、三栏布局比例、按钮与空状态视觉 | 精简后复制到本项目主题变量，并记录来源 |
| B：可选择迁移 | Avatar、简单图标包装、图片结果卡片、模型图标映射、纯展示型 Markdown 样式 | 逐文件检查 import；只迁移无 Electron/数据层依赖的小组件 |
| C：按外观重写 | 左侧助手/话题列表、顶部导航、消息气泡、纯文本输入器、模型选择器、Provider 配置抽屉 | 保留交互与视觉语言，用本项目领域模型重写 |
| D：禁止迁移 | HomePage、Topics、ChatComposer、完整 MessageParts、Redux/Dexie、Electron main/preload、AI Core、Provider Registry 全包 | 不复制，防止把被删除能力带回新项目 |

第一版不引入整个 `@cherrystudio/ui` 工作区包。该包规模较大，复制后仍会带来不必要组件和维护面。只抽取必要的设计 Token 和极少量 primitives。

### 4.3 品牌与许可证

本地参考仓库的 `LICENSE` 是标准 AGPL-3.0，README 也声明 Cherry Studio Community Edition 使用 AGPL-3.0。只要复制其受版权保护的源码或样式，本项目就应按衍生作品路径处理：

- 原型默认按 AGPL-3.0 兼容方式保留许可证、版权信息、修改说明和完整对应源码。
- 不复制 Cherry 名称、Logo、应用图标等品牌资产；产品名暂用 MyAIUI2。
- 若目标单位要求闭源、商业分发或许可证政策禁止 AGPL，必须在复制代码前取得 Cherry 商业许可，或改成只参考交互、全部自行实现。
- 该判断是工程风险提示，不替代正式法律意见。

实施阶段应创建 `THIRD_PARTY_NOTICES.md` 和 `docs/UPSTREAM_REUSE.md`，逐项登记来源文件、提交 SHA、修改内容和许可证。

## 5. 技术选型

| 层 | 选型 | 原因 |
| --- | --- | --- |
| 桌面框架 | Wails v2.15.x | 当前稳定版；v3 在 2026-09 仍是 beta，不用于快速内网原型 |
| 后端 | Go 1.25+，本机已有 Go 1.26 | 单二进制、启动快、Wails 原生绑定；只做薄服务 |
| 前端 | React 19 + TypeScript + Vite + pnpm | 与 Cherry Studio UI 技术相近，便于迁移视觉与组件 |
| AI 接入 | Vercel AI SDK 6 `ai` + `@ai-sdk/openai-compatible` | 统一文本流、图片模型和 Provider 抽象；参考项目也已在用 AI SDK 6 |
| 状态 | React hooks + Zustand（仅瞬时 UI 状态） | 避免 Redux/持久化中间件；数据库才是事实源 |
| Markdown | `react-markdown`/`remark-gfm` + 严格渲染器 | 比迁移 Cherry 的复杂 Markdown Runtime 更小，默认不执行 HTML |
| 本地数据库 | SQLite，优先 `modernc.org/sqlite` | 无独立数据库进程；避免 Windows CGO 构建负担 |
| 密钥 | Windows DPAPI | API Key 不以明文进入 SQLite、日志或 localStorage |
| 图标 | `lucide-react` + 自制 Provider 首字母图标 | 轻量且不复制 Cherry 品牌资源 |
| 路由 | 不引入路由库 | 产品只有一个页面；设置均为抽屉/对话框 |

不使用前端 `localStorage` 保存业务数据和密钥。最多允许保存不敏感、可丢失的窗口 UI 状态；为边界更清晰，P0 也统一通过 Go Settings 存储。

## 6. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│ React / TypeScript 单页                                      │
│ Chat UI · Assistant/Topic · Provider UI · Search UI          │
│ AI SDK adapters · prompt assembly · streaming state          │
└───────────────┬───────────────────────────┬──────────────────┘
                │ typed Wails bindings      │ Wails events
┌───────────────▼───────────────────────────▼──────────────────┐
│ Go/Wails 薄后端                                              │
│ AppAPI facade · repositories · DPAPI secrets                │
│ allowlisted HTTP transport · lifecycle · safe external URL  │
└───────────────┬───────────────────────────┬──────────────────┘
                │                           │ HTTPS/HTTP
       ┌────────▼────────┐        ┌────────▼────────────────┐
       │ app data SQLite │        │ configured AI/Search    │
       │ fixed directory │        │ endpoints only          │
       └─────────────────┘        └─────────────────────────┘
```

关键约束：

- 发布版本不监听本地端口，不存在 API Server；前后端只通过进程内 Wails bindings/events 通信。
- 前端静态资源嵌入最终二进制。
- AI SDK 在前端运行，但通过自定义 `fetch` 使用 Go 的受限网络桥。这样保留“前端 AI 接入层”，同时规避 WebView CORS，并避免真实 API Key 暴露给 JS。
- Go 网络桥只识别“已保存的 Provider/Search Service ID + 相对路径”，不接受任意 URL，不组装 AI Prompt，不解析模型语义。

## 7. 目标代码目录

```text
MyAIUI2/
├─ main.go                         # Wails 入口、嵌入 frontend/dist
├─ app.go                          # 生命周期；只绑定 AppAPI
├─ go.mod
├─ go.sum
├─ wails.json
├─ build/                          # Windows 清单、图标、安装构建配置
├─ internal/
│  ├─ api/
│  │  ├─ app_api.go                # 暴露给 JS 的最小门面
│  │  ├─ dto.go                    # Wails DTO；不暴露数据库实体
│  │  └─ validation.go
│  ├─ database/
│  │  ├─ database.go               # SQLite 连接、WAL、事务
│  │  ├─ schema.sql                # P0 一次性 schema
│  │  └─ migration.go              # 简单 user_version；不引入复杂迁移框架
│  ├─ repository/
│  │  ├─ provider_repository.go
│  │  ├─ assistant_repository.go
│  │  ├─ topic_repository.go
│  │  ├─ message_repository.go
│  │  └─ settings_repository.go
│  ├─ secret/
│  │  ├─ store.go                  # 接口
│  │  └─ dpapi_windows.go          # Windows DPAPI 实现
│  ├─ transport/
│  │  ├─ bridge.go                 # 白名单 HTTP 请求与取消
│  │  ├─ policy.go                 # origin/path/header/redirect 规则
│  │  └─ events.go                 # header/chunk/end/error 事件
│  ├─ platform/
│  │  └─ external_url.go           # 只允许 http/https
│  └─ logging/
│     └─ logger.go                 # 脱敏日志
├─ frontend/
│  ├─ package.json
│  ├─ vite.config.ts
│  ├─ tsconfig.json
│  ├─ index.html                   # CSP、禁止远程脚本
│  └─ src/
│     ├─ main.tsx
│     ├─ app/
│     │  ├─ App.tsx
│     │  ├─ bootstrap.ts
│     │  └─ uiStore.ts
│     ├─ bridge/
│     │  ├─ appApi.ts              # 生成绑定的薄包装
│     │  ├─ wailsFetch.ts          # AI SDK custom fetch
│     │  └─ streamEvents.ts
│     ├─ domain/
│     │  ├─ assistant.ts
│     │  ├─ topic.ts
│     │  ├─ message.ts
│     │  ├─ provider.ts
│     │  └─ model.ts
│     ├─ features/
│     │  ├─ chat/
│     │  │  ├─ ChatWorkspace.tsx
│     │  │  ├─ MessageList.tsx
│     │  │  ├─ MessageItem.tsx
│     │  │  ├─ TextComposer.tsx
│     │  │  ├─ useChat.ts
│     │  │  └─ markdown/
│     │  ├─ assistants/
│     │  │  ├─ AssistantList.tsx
│     │  │  └─ AssistantEditor.tsx
│     │  ├─ topics/
│     │  │  ├─ TopicList.tsx
│     │  │  └─ TopicActions.tsx
│     │  ├─ providers/
│     │  │  ├─ ProviderDrawer.tsx
│     │  │  ├─ ProviderForm.tsx
│     │  │  ├─ ModelList.tsx
│     │  │  └─ modelSync.ts
│     │  ├─ search/
│     │  │  ├─ SearchToggle.tsx
│     │  │  ├─ searchAdapter.ts
│     │  │  └─ SearchResults.tsx
│     │  └─ images/
│     │     ├─ ImageResult.tsx
│     │     └─ imagePolicy.ts
│     ├─ lib/ai/
│     │  ├─ providerFactory.ts
│     │  ├─ chatEngine.ts
│     │  ├─ imageEngine.ts
│     │  ├─ capability.ts
│     │  └─ adapters/
│     │     ├─ openaiCompatible.ts
│     │     ├─ openai.ts            # P1 可启用
│     │     ├─ anthropic.ts         # P1 可启用
│     │     └─ google.ts            # P1 可启用
│     ├─ components/
│     │  ├─ layout/
│     │  ├─ ui/                     # 本项目最小 primitives
│     │  └─ icons/
│     └─ styles/
│        ├─ tokens.css              # 精简后的 Cherry 风格变量
│        ├─ global.css
│        ├─ markdown.css
│        └─ scrollbar.css
├─ docs/
│  ├─ IMPLEMENTATION_PLAN.md
│  ├─ UPSTREAM_REUSE.md             # 实施阶段创建
│  └─ MANUAL_SMOKE_TEST.md          # 实施阶段创建
├─ temp/                            # 临时文件和临时脚本统一放这里
├─ THIRD_PARTY_NOTICES.md           # 实施阶段创建
└─ README.md
```

## 8. 单页 UI 设计

### 8.1 页面结构

只保留一个 `ChatWorkspace`：

- 左侧第一列（约 64px）：助手头像列表，底部“添加助手”和“模型服务”。
- 左侧第二列（约 240px）：当前助手的话题列表，顶部“新建话题”。
- 中间主区域：顶部助手名/话题名/模型选择/联网开关；中部消息；底部纯文本输入框。
- Provider、Assistant 设置以右侧 Drawer 或 Modal 打开，不新增路由页面。

窄窗口下把两级侧栏折叠成一个抽屉，但仍是同一页面。

### 8.2 输入器

只实现这些操作：

- 纯文本输入。
- Enter 发送、Shift+Enter 换行。
- 发送/停止按钮。
- 当前模型选择。
- 联网搜索开关。

明确不显示：回形针、相机、知识库、MCP、工具、@ 文件、Skill、Agent 模式、录音、截图、引用附件。

### 8.3 消息展示

P0 消息 Part 只有：

```ts
type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'search-result'; title: string; url: string; snippet: string }
  | { type: 'image'; source: 'generated' | 'remote'; mimeType: string; data?: string; url?: string }
  | { type: 'error'; code: string; message: string }
```

不定义 file、attachment、tool、mcp、knowledge、artifact 或 agent Part，避免以后被 UI “顺手恢复”。

### 8.4 助手不是智能体

本文的“助手”只是静态对话模板：名称、图标、系统提示词、默认模型和生成参数。它不会自主循环、调用电脑工具、执行命令、访问文件或后台运行任务。

## 9. 本地数据设计

### 9.1 数据库位置

发布版固定放在 `%LOCALAPPDATA%\MyAIUI2\data\app.db`。前端看不到该路径，所有 CRUD 通过无路径参数的 typed bindings 完成。

SQLite 使用 WAL、foreign keys、busy timeout。P0 使用简单的 `PRAGMA user_version` 升级，不移植 Cherry 的 Drizzle/Dexie/迁移系统。

### 9.2 表结构

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_cipher BLOB,
  enabled INTEGER NOT NULL DEFAULT 1,
  model_path TEXT NOT NULL DEFAULT '/models',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  last_sync_error TEXT
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  modality TEXT NOT NULL DEFAULT 'text',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'synced',
  enabled INTEGER NOT NULL DEFAULT 1,
  missing_remote INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  UNIQUE(provider_id, remote_id)
);

CREATE TABLE assistants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  system_prompt TEXT NOT NULL DEFAULT '',
  provider_id TEXT REFERENCES providers(id),
  model_id TEXT REFERENCES models(id),
  temperature REAL,
  web_search_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  provider_id TEXT,
  model_remote_id TEXT,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(topic_id, sort_order)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_topics_assistant_updated ON topics(assistant_id, updated_at DESC);
CREATE INDEX idx_messages_topic_order ON messages(topic_id, sort_order);
CREATE INDEX idx_models_provider_enabled ON models(provider_id, enabled);
```

搜索服务的 URL、类型和开关放在 allowlisted Settings DTO 中；搜索密钥也用 DPAPI 加密，不能放入普通 `value_json`。

### 9.3 写入时机

1. 发送前先事务性保存用户消息和 assistant placeholder。
2. 前端开始 AI 请求并在内存更新流式内容。
3. 每 1 秒最多保存一次快照；结束时保存最终 Parts 和状态。
4. 取消写入 `cancelled`；网络错误写入安全化后的 `error`。
5. 标题第一版取首条用户消息前 30 个字符，不额外调用模型，减少网络与开发量。

## 10. Wails 绑定接口

只绑定一个 `AppAPI` 门面。内部 Repository、SecretStore 和 Transport 不直接暴露。

```go
type AppAPI struct { /* private services */ }

func (a *AppAPI) Bootstrap() (BootstrapDTO, error)

func (a *AppAPI) ListProviders() ([]ProviderDTO, error)
func (a *AppAPI) SaveProvider(input SaveProviderDTO) (ProviderDTO, error)
func (a *AppAPI) DeleteProvider(id string) error
func (a *AppAPI) TestProvider(id string) (ConnectionResultDTO, error)
func (a *AppAPI) SyncProviderModels(id string) (ModelSyncResultDTO, error)
func (a *AppAPI) SaveManualModel(input SaveModelDTO) (ModelDTO, error)
func (a *AppAPI) SetModelEnabled(id string, enabled bool) error

func (a *AppAPI) ListAssistants() ([]AssistantDTO, error)
func (a *AppAPI) SaveAssistant(input SaveAssistantDTO) (AssistantDTO, error)
func (a *AppAPI) DeleteAssistant(id string) error

func (a *AppAPI) ListTopics(assistantID string) ([]TopicDTO, error)
func (a *AppAPI) CreateTopic(input CreateTopicDTO) (TopicDTO, error)
func (a *AppAPI) RenameTopic(id, title string) error
func (a *AppAPI) DeleteTopic(id string) error

func (a *AppAPI) ListMessages(topicID string, before *int, limit int) ([]MessageDTO, error)
func (a *AppAPI) StartTurn(input StartTurnDTO) (TurnDTO, error)
func (a *AppAPI) SaveAssistantSnapshot(input SaveMessageSnapshotDTO) error
func (a *AppAPI) FinishTurn(input FinishTurnDTO) error

func (a *AppAPI) StartProviderRequest(input ProviderRequestDTO) (RequestHandleDTO, error)
func (a *AppAPI) CancelProviderRequest(requestID string) error
func (a *AppAPI) StartSearchRequest(input SearchRequestDTO) (RequestHandleDTO, error)

func (a *AppAPI) OpenExternalURL(rawURL string) error
```

DTO 验证规则：

- 所有 ID 都是限定长度 UUID，禁止路径分隔符。
- 标题、助手名、Prompt 和消息有明确长度上限。
- `base_url` 只允许 `http`/`https`，禁止用户名密码、fragment 和非标准 URL。
- 网络桥只接收 Provider ID、方法、相对路径、有限请求头和请求体；真实密钥由 Go 注入。
- 外部链接只允许 `http`/`https`，拒绝 `file:`、`shell:`、UNC、`javascript:`、`data:`。

## 11. 前端 AI SDK 接入

### 11.1 Provider 工厂

P0 主实现：

```ts
const provider = createOpenAICompatible({
  name: runtime.providerName,
  baseURL: runtime.publicBaseUrl,
  apiKey: '__managed_by_go__',
  fetch: createWailsFetch(runtime.providerId),
  includeUsage: true,
})
```

`createWailsFetch(providerId)` 将 SDK 的标准 Fetch 请求转成 Wails binding 调用；Go 会丢弃占位 Authorization，注入 DPAPI 解密后的真实密钥，并通过 Wails events 返回 response headers/chunks/end/error。前端把事件重组成 `Response` 和 `ReadableStream`，因此 AI SDK 的 provider/streaming 逻辑仍全部在前端。

这条窄桥是必要的工程例外：直接从 WebView 请求会受到 CORS 限制，并让真实密钥进入 JS 内存。它不是 API Server，也不监听端口。

### 11.2 文本对话流程

```text
用户纯文本 → StartTurn 落库 → 读取助手/模型快照
→ 可选搜索 → 组装 system + search context + history + user
→ AI SDK streamText → UI 增量渲染
→ 节流保存 snapshot → FinishTurn
```

P0 限制：

- 单一话题同时只允许一个生成任务。
- 默认只加载最近 50 条消息；超出后按字符上限从旧到新裁剪。
- 不实现自动摘要、长期记忆和 Agent tool loop。
- Provider 返回的 tool call 一律不执行；显示“不支持工具调用”。
- `telemetry` 明确关闭。

### 11.3 图片生成流程

模型 `modality=image` 时，发送按钮调用 `generateImage`，输入仍然只是纯文本。结果被转换为 `image` Part。P0 每次只生成 1 张图，限制允许的 MIME 为 PNG/JPEG/WebP，解码后上限建议 10 MB。

自动同步无法可靠判断所有模型能力，因此：

- 对常见模型 ID 做保守启发式识别。
- Provider/模型编辑器允许用户把模型手动标为“文本”或“图片”。
- 未知模型默认为文本模型，避免误调用图片 API。

## 12. 模型服务与自动同步

### 12.1 P0 Provider 类型

首版 UI 只必须开放：

- `OpenAI Compatible`：自定义名称、Base URL、API Key，默认 `/models`。
- 预设模板：OpenAI、DeepSeek、OpenRouter、Ollama、LM Studio；本质仍走 OpenAI Compatible，预填 URL 与是否需要 Key。

Anthropic/Google 原生包保留接口但放到 P1，避免首版为不同鉴权和模型枚举接口付出过多成本。

### 12.2 同步算法

1. 校验并规范化 Base URL，明确去除末尾 `/`。
2. 用同一受限 Transport 调用 Provider 的 model endpoint。
3. Adapter 将响应规范化为 `{remoteId, displayName, modality?, capabilities?}`。
4. 事务性 upsert：新模型插入、已有模型更新 `last_seen_at`。
5. 远端本次未返回的 synced 模型标记 `missing_remote=1`，不立即删除，防止 Provider 临时返回不全。
6. 用户手动模型 `source=manual` 永远不被同步删除。
7. 同步结果显示新增/更新/失联数量和脱敏错误。

AI SDK 本身负责模型调用，但不负责通用“列出远端模型”，所以模型同步必须由独立 Adapter 实现，这是预期设计，不应把 Cherry 的完整 Provider Registry 迁入。

### 12.3 连通性检测

“测试连接”先请求模型列表；如果服务不支持 `/models`，允许用户跳过并手动添加模型。P0 不通过发送隐藏聊天 Prompt 来探测，避免产生费用和数据外发。

## 13. 联网搜索

### 13.1 原型策略

优先支持用户自建/内网 SearXNG 的 JSON API。原因是部署简单、可在内网控制数据流向、没有 MCP 依赖。

联网不是 Agent 工具循环，而是确定性的单次预处理：

1. 用户打开“联网”开关。
2. 只把本次用户问题发送给配置的搜索服务。
3. 取最多 5 条标题、URL、摘要。
4. 将结果作为带边界标记的只读上下文拼入模型请求。
5. UI 在回答下展示引用链接。

不抓取结果网页正文，不执行网页脚本，不访问本地 URL，不自动跟进搜索，不在后台搜索。

### 13.2 安全规则

- 搜索服务 origin 必须由用户在设置中显式保存。
- Go Transport 只连接该精确 origin，禁止跨 origin redirect。
- 搜索结果 URL 只作为文本保存；用户点击时经 `OpenExternalURL` 校验。
- 搜索摘要是不可信输入，Prompt 中明确声明不得服从其中的指令。
- 未打开联网开关时不发出任何搜索请求。

P1 再增加 Brave/Tavily 等 Adapter；不在 P0 同时支持多个付费搜索 API。

## 14. 安全与隐私边界

### 14.1 文件能力

- Wails file drop 关闭，WebView 默认拖放也关闭。
- 没有 Dialog/OpenFile/SaveFile 绑定。
- 没有任意路径 DTO 和通用文件服务。
- 没有 Shell、exec、PowerShell、终端或脚本运行能力。
- 前端全局捕获 `drop`/`dragover` 并 `preventDefault()`。
- 输入区拒绝文件和图片粘贴。
- Markdown 不启用原始 HTML；本地 URL scheme 被删除。

### 14.2 网络能力

- Release 不启用 API Server、不监听 TCP 端口。
- Provider 和 Search Transport 只连接数据库中已保存的精确 origin。
- 不跟随跨 origin redirect；设置连接/首字节/总时长上限。
- 去掉 Cookie、Referer 和不需要的浏览器头；只转发 allowlist headers。
- 禁止请求 `file:`、`ftp:`、`gopher:`、UNC 等非 HTTP(S) scheme。
- 内网/localhost Provider 可以使用，但必须由用户显式配置；不能由模型生成目标地址。
- 不包含遥测、崩溃上报、自动更新或第三方字体/CDN。

### 14.3 密钥

- API Key 用当前 Windows 用户的 DPAPI 加密后保存。
- List/Get DTO 只返回 `hasApiKey`，从不返回真实 Key。
- AI SDK custom fetch 使用占位 Key；Go Transport 注入真实 Key。
- 日志禁止记录 Authorization、请求体、Prompt、模型响应和完整 URL query。
- Provider 更新时空 Key 表示保留原 Key，显式 `clearApiKey` 才删除。

### 14.4 模型与搜索数据外发说明

“无数据上传功能”不等于“对话内容不发送给模型服务”。完成 AI 对话必须把 Prompt/上下文发送到用户配置的模型 endpoint；打开联网后，本次查询也会发送到搜索 endpoint。界面应在 Provider/Search 配置处明确展示这点，但不建设复杂的“数据设置”页面。

### 14.5 发布设置

- Release 禁用 DevTools 和默认右键菜单。
- 不设置额外 `BindingsAllowedOrigins`。
- Content Security Policy 禁止远程脚本、插件、object、frame；`connect-src` 仅保留 Wails 必需源。
- 图片渲染只接受结构化结果；普通 Markdown image 被禁用。
- 使用 `wails build -trimpath`，避免二进制携带本机源码绝对路径。

## 15. 详细任务分解

以下任务按可独立提交的粒度设计。估时为熟悉 React/Go 的单人净开发时间，不含许可证审批和 UI 反复评审。

### 阶段 A：工程与边界（0.5 天）

#### A-01 许可证与复用台账（1h）

- 确定 AGPL 路线或商业许可路线。
- 添加 LICENSE、THIRD_PARTY_NOTICES、UPSTREAM_REUSE。
- 固定上游 commit SHA，禁止后续直接从浮动 main 复制。

完成标准：每个迁移文件有来源和修改记录；无 Cherry 品牌资产。

#### A-02 Wails 脚手架（2h）

- 安装并固定 Wails v2.15.x CLI。
- 初始化 React-TS 项目；调整为 pnpm。
- 配置 `frontend/dist` embed、Windows 窗口、单实例。
- 建立 `internal/` 和前端 feature 目录。

完成标准：`wails dev` 显示空工作台；`wails build` 生成 Windows 二进制。

#### A-03 安全基线（1h）

- 禁用 file drop、WebView drop、默认右键菜单、release DevTools。
- 加 CSP、全局 paste/drop 防护、URL scheme 校验骨架。
- 确认无文件/对话框/Shell 绑定。

完成标准：拖入文件不打开；粘贴图片被拒绝；绑定清单只有 AppAPI。

### 阶段 B：Cherry 风格单页 UI（1 天）

#### B-01 设计 Token 与基础组件（2h）

- 提取浅/深色变量、边框、圆角、间距、滚动条。
- 建立 Button、IconButton、Dialog、Drawer、Input、Select、Tooltip。
- 登记所有上游样式来源。

完成标准：不依赖 `@cherrystudio/ui` 整包；基础组件无业务 import。

#### B-02 三栏 ChatWorkspace（3h）

- 助手栏、话题栏、聊天主区、响应式折叠。
- 顶部模型选择、联网开关、模型服务入口。
- 空状态和首屏引导。

完成标准：只有一个页面；所有配置从抽屉/弹窗进入。

#### B-03 纯文本消息 UI（3h）

- 消息列表、Markdown 文本、代码块、reasoning 折叠、错误卡。
- TextComposer、发送/停止、复制文本。
- ImageResult 只读卡片骨架。

完成标准：UI 中找不到任何附件、MCP、Agent、知识库或工具入口。

### 阶段 C：本地数据（0.75 天）

#### C-01 SQLite 与 schema（2h）

- 固定应用数据目录、建库、PRAGMA、schema/user_version。
- Repository 基础设施和事务 helper。

完成标准：首次运行自动建库；重复启动幂等。

#### C-02 AppAPI CRUD（3h）

- Provider/Model/Assistant/Topic/Message/Settings typed DTO。
- 输入长度、ID 和枚举验证。
- Bootstrap 一次返回首屏必要数据。

完成标准：前端没有 SQL、路径或 localStorage 业务持久化。

#### C-03 DPAPI（1h）

- 保存、替换、清空、解密 API Key。
- 日志脱敏和错误文本脱敏。

完成标准：SQLite/日志中搜索不到测试 Key 明文。

### 阶段 D：模型服务（1 天）

#### D-01 Provider 配置抽屉（2.5h）

- OpenAI Compatible 表单、模板、启停、删除。
- API Key 回显只展示“已配置”。
- URL 与超时校验。

完成标准：能配置内网 OpenAI-compatible endpoint。

#### D-02 模型同步（3h）

- `/models` Adapter、同步事务、missing 标记、手动模型。
- 测试连接和结果摘要。
- 模型启停、modality 手动修正。

完成标准：新增 Provider 后一键得到可选择模型；不支持枚举时可手动添加。

#### D-03 受限 Transport（2.5h）

- 精确 origin/path policy、header allowlist、真实密钥注入。
- 请求取消、超时、禁止跨 origin redirect。
- Wails response/chunk/end/error events。

完成标准：传入任意 URL、`file:`、不同 origin 均失败；已配置 endpoint 正常返回。

### 阶段 E：对话闭环（1 天）

#### E-01 `wailsFetch`（3h）

- 将 AI SDK Fetch 映射为 Go Transport。
- 用 Wails events 重建 `ReadableStream<Response>`。
- 处理取消、HTTP 错误、断流和 cleanup。

完成标准：API Key 不进入前端；AI SDK 能收到标准流。

#### E-02 Chat Engine（3h）

- Provider factory、消息转换、上下文裁剪、`streamText`。
- 单话题互斥、停止、重试。
- 禁止 tool call 执行和 telemetry。

完成标准：可连续多轮对话，重启后历史仍在。

#### E-03 消息落库与恢复（2h）

- StartTurn、节流 snapshot、FinishTurn/error/cancelled。
- 启动时把遗留 streaming 状态改为 interrupted。

完成标准：强制关闭后重启不会出现永久“生成中”。

### 阶段 F：助手与话题（0.5 天）

#### F-01 助手 CRUD（2h）

- 添加/编辑/删除，Emoji 而非上传头像。
- 默认模型、系统提示词、温度、默认联网开关。

完成标准：不同助手使用各自配置，且不具备工具/文件能力。

#### F-02 话题 CRUD（2h）

- 新建、重命名、删除、切换、自动标题。
- 删除确认；P0 直接删除，不建设回收站和数据设置。

完成标准：话题按助手隔离，删除后数据库级联清理消息。

### 阶段 G：搜索与图片（0.75 天）

#### G-01 SearXNG 搜索（3h）

- 搜索设置、单次预搜索、结果规范化、5 条上限。
- Prompt 注入边界、引用展示、安全外链。

完成标准：开关关闭时无搜索网络请求；开启时回答带可审计引用。

#### G-02 图片输出（3h）

- 图片模型调用、structured image part、MIME/大小检查。
- HTTPS/base64 图片展示；禁止本地 URL、Markdown 任意图片和另存为。

完成标准：纯文本 Prompt 可得到并查看图片；图片无法再次作为输入。

### 阶段 H：收尾与交付（0.5～1 天）

#### H-01 依赖与能力审计（2h）

- `rg` 检查 mcp/agent/file/knowledge/openclaw/server/channel 等禁用词与依赖。
- 检查 Wails bindings、网络 origin、npm/go 依赖和许可证。
- 检查无 Sentry/analytics/updater/CDN。

#### H-02 人工冒烟（2h）

- 执行第 17 节清单。
- 只修阻断主链路的问题，不补完整测试套件。

#### H-03 Windows 打包（2～4h）

- `wails build -clean -trimpath -platform windows/amd64`。
- 决定 WebView2 Runtime 策略；内网环境推荐离线前置包或固定 Runtime。
- 输出安装/绿色包和部署说明。

## 16. 里程碑与开发顺序

### 3 天演示版

- Day 1：A + B，完成可交互的单页 UI。
- Day 2：C + D，完成本地数据、Provider 配置和模型同步。
- Day 3：E + F，完成多轮对话、助手和话题。

Day 3 结束即可内部演示，但不承诺搜索、图片和完整安全审计。

### 5～7 天可交付原型

- Day 4：G，完成 SearXNG 与图片输出。
- Day 5：H，完成安全/依赖审计和 Windows 构建。
- Day 6～7：处理内网 endpoint 兼容、WebView2 部署和 UI 修正缓冲。

最短关键路径：A-02 → C-01/C-02 → D-03 → E-01/E-02。UI 和数据层可以并行，但单人时建议先做一条最小 vertical slice：一个默认助手 + 一个话题 + 一个 Provider + 一次对话，然后再补完整 UI。

## 17. 原型验收清单

不建设自动化测试套件，但以下人工验收必须全部通过。

### 17.1 核心功能

- [ ] 新安装后能创建第一个模型服务并同步模型。
- [ ] `/models` 不可用时能手工添加模型。
- [ ] 能添加助手，并设置系统提示词和默认模型。
- [ ] 能在助手下新建、重命名、删除、切换话题。
- [ ] 只能输入/粘贴纯文字，可正常进行连续多轮对话。
- [ ] 可以停止生成、重新生成、复制文本。
- [ ] 重启应用后助手、话题、消息和模型配置仍在。
- [ ] 打开联网开关后能显示搜索来源；关闭时没有搜索请求。
- [ ] 选择图片模型后，纯文本 Prompt 能返回并显示图片。

### 17.2 文件隔离

- [ ] 应用中没有打开、保存、导入、导出、附件和上传按钮。
- [ ] 拖入本地文件不会打开、读取或显示路径。
- [ ] 粘贴图片/文件被拒绝，纯文字仍可粘贴。
- [ ] Wails generated bindings 中没有路径型文件接口。
- [ ] 代码中不存在 `os.ReadFile`/`os.Open` 对任意用户路径的调用；固定 schema/embed/DB 初始化除外。
- [ ] `file:`、UNC 和本地路径形式的模型输出不会成为可点击或可渲染资源。

### 17.3 数据与网络

- [ ] 数据库和日志中不存在 API Key 明文。
- [ ] 日志不包含 Prompt、回答正文或 Authorization。
- [ ] Release 不开启监听端口。
- [ ] 任意 URL 不能借网络桥访问；只有已配置精确 origin 可用。
- [ ] 跨 origin redirect 被拒绝。
- [ ] 无遥测、Sentry、自动更新、云备份和官方中转请求。

### 17.4 构建

- [ ] `pnpm typecheck` 通过。
- [ ] `go vet ./...` 通过。
- [ ] `wails build -clean -trimpath -platform windows/amd64` 通过。
- [ ] 在一台无开发环境的 Windows 内网机器上启动并对接测试模型服务。

## 18. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| Cherry 代码 AGPL | 闭源/分发合规风险 | 先定许可证；登记复用；必要时只重写视觉或采购商业许可 |
| 直接复制聊天组件 | 把 Agent/File/MCP 依赖带回 | 只迁移低耦合 primitives，核心页面按新领域重写 |
| WebView CORS | 前端直连 Provider 失败 | AI SDK custom fetch + Wails 受限 Transport |
| API Key 暴露 | JS/XSS 可窃取密钥 | DPAPI + Go 注入真实 Key + CSP + 禁止远程脚本 |
| Wails v3 尚未稳定 | API 变化、打包风险 | P0 使用 v2.15.x，不追 v3 beta |
| 不同 Provider 不兼容 `/models` | 自动同步失败 | Adapter + 自定义 model path + 手动添加模型兜底 |
| 图片响应差异大 | 无法统一展示 | 明确 image model；结构化 Part；用户手动标 modality |
| “完全不能访问文件”理解不同 | 验收争议 | 文档化“无任意用户文件能力”；若需 OS 强沙箱另立项目 |
| 内网无 WebView2/依赖下载 | 应用无法启动/构建 | 准备离线依赖缓存与 WebView2 离线 Runtime |
| 不写自动化测试 | 回归风险较高 | P0 限制范围；强制 typecheck/build/manual smoke；P1 补核心测试 |

## 19. 初始依赖控制

前端 P0 只应包含近似以下运行时依赖：

- `react`, `react-dom`
- `ai`, `@ai-sdk/openai-compatible`
- `zustand`
- `zod`
- `react-markdown`, `remark-gfm`
- `lucide-react`
- `clsx`

是否增加 `@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/google` 必须由已排期的 Provider 决定，不能预装一批未使用适配器。

Go P0 运行时依赖只应包含：

- `github.com/wailsapp/wails/v2`
- SQLite driver
- 一个经过审查的 Windows DPAPI 包，或极小的 syscall 封装
- UUID 包（也可用标准/内部实现）

禁止出现的依赖族：Electron、MCP SDK、Agent SDK、OpenClaw、OCR、PDF、Office、向量库、Embedding、对象存储、Sentry、Analytics、Updater、Web Server framework。

## 20. 开发环境现状与初始化命令

审查时本机状态：

- Git：已安装。
- Go：`go1.26.4 windows/amd64`。
- Node：`v26.4.0`。
- pnpm：`11.9.0`。
- Wails CLI：尚未安装。
- `D:\WorkProject\MyAIUI2`：已初始化为 `main` 分支的 Git 仓库。

实施时建议固定 Wails v2.15.x，不使用浮动 `latest`。脚手架完成后立即提交 lockfile。Node 若遇到生态兼容问题，切换到当时的 LTS 版本，不为追新升级依赖。

预期命令形态：

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
wails doctor
wails init -n MyAIUI2 -t react-ts
pnpm --dir frontend install
wails dev
wails build -clean -trimpath -platform windows/amd64
```

具体 Wails patch 版本应在实施开始时再核对一次官方发布页后固定。

## 21. 实施时的删除审计关键词

在交付前对 `go.mod`、`frontend/package.json` 和源码执行关键词审计。关键词命中不一定都是问题，但必须逐条解释：

```text
mcp|agent|openclaw|knowledge|embedding|vector|rag
attachment|upload|file picker|dialog.Open|ReadFile|WriteFile
ocr|pdf|docx|xlsx|pptx|screenshot
channel|telegram|lark|bot
api server|gateway|elysia|express|websocket|listen
sentry|analytics|telemetry|updater|webdav|s3
electron|ipcRenderer|preload
```

允许出现的例外包括需求文档、`User-Agent` HTTP 头、以及固定应用数据库/嵌入资源的文件操作。

## 22. 参考资料

- Wails v2 创建 React TypeScript 项目：<https://v2.wails.io/docs/gettingstarted/firstproject/>
- Wails v2 工作原理与嵌入前端：<https://v2.wails.io/docs/howdoesitwork/>
- Wails v2 应用选项（含禁用文件拖放）：<https://v2.wails.io/docs/reference/options/>
- Wails v2 前后端绑定：<https://v2.wails.io/docs/guides/frontend/>
- Wails v2 Events：<https://v2.wails.io/docs/reference/runtime/events/>
- Wails Windows/WebView2：<https://v2.wails.io/docs/guides/windows/>
- Wails v3 当前变更记录（当前仍为 beta）：<https://v3.wails.io/changelog/>
- Vercel AI SDK Core：<https://ai-sdk.dev/docs/reference/ai-sdk-core>
- AI SDK `streamText`：<https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text>
- AI SDK OpenAI Compatible Provider：<https://ai-sdk.dev/providers/openai-compatible-providers>
- Cherry Studio 上游：<https://github.com/CherryHQ/cherry-studio>

## 23. 最终推荐决策

直接按以下默认值开工，无需等待额外产品讨论：

1. Windows x64 + Wails v2.15.x。
2. 新工程重写业务层，只选择性迁移 Cherry 视觉和低耦合组件。
3. P0 只开放 OpenAI Compatible，内置若干 URL 模板。
4. AI SDK 6 在前端运行，Go 提供无 AI 语义的受限流式 Transport。
5. SearXNG 作为首个联网搜索实现，不做 MCP、不爬正文。
6. SQLite + DPAPI；无备份、导入导出、遥测和自动更新。
7. 严格纯文本输入；图片只作为模型输出。
8. 第 3 天先交付可对话演示版，第 5～7 天完成全部 P0 与安全审计。
