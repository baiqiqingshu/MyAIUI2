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
  - 2026-09-19 修订：新增一个用户显式批准的文件出口——「导出为 Markdown → 另存为 .md 文件」（方案 §24）。目标路径由用户在系统保存对话框中选定，Go 侧重新生成正文，前端不能提交任意内容或指定目录；其余「无文件入口」要求不变。逐项验证见第 7 节。
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

## 7. 增量功能（2026-09-19：会话内分支 / 复制为新会话 / Markdown 导出）

执行环境：`build/bin/MyAIUI2-dev.exe` + `vite`（隔离数据目录 `LOCALAPPDATA=<temp>`，数据库为上一轮真实库的副本，
用于验证 v1→v2 迁移）+ `temp/fake_provider.py`（本地假 OpenAI 兼容服务端，端口 8791）+ 浏览器会话驱动真实 Wails 绑定；
发布构建 `build/bin/MyAIUI2.exe` 另用于确认打包。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| schema v1 → v2 迁移 | 通过 | 副本库 `user_version=1→2`；`messages.parent_id` 按 `sort_order` 回填为线性父链；`topics.active_node_id` 指向每条话题末条消息；6 条历史消息与 2 个话题全部保留，`UNIQUE(topic_id, sort_order)` 移除 |
| 连续对话 | 通过 | 假服务端收到 `messages=3`（迁移历史 2 条 + 本轮提问）并流式返回；消息落库 `status=done` |
| 重新生成 = 兄弟变体 | 通过 | 同一用户消息下出现 `1/2`、`2/2` 两个助手节点；新回答成为活动节点，旧回答保留为变体；界面出现 `‹ 2/2 ›` 导航 |
| 兄弟切换 | 通过 | 点 `‹` 后 `ActiveNodeID` 切到 `1/2`，消息列表按新分支重载，导航显示 `‹ 1/2 ›`；反向切换回到最深分支 |
| 编辑并重新发送 | 通过 | 用户消息出现 `1/2`、`2/2` 变体；新分支的模型上下文为「被编辑消息之前的路径」（假服务端收到 `messages=3`），旧分支完整保留 |
| 分支管理面板 | 通过 | 面板按父链缩进（10/28/46/64px）、显示角色图标、`n/m` 变体徽标、分支点徽标与「当前」标记；点击任意节点即精确回退（`ActiveNodeID` 落到该节点，消息列表随之缩短）；生成中禁止切换 |
| 停在用户消息上的发送守卫 | 通过 | 回退到用户消息后直接发送被拦截（toast 提示改用「编辑并重新发送」），假服务端无请求，草稿保留 |
| 复制为新会话 | 通过 | 新话题标题 `<原标题>（副本）`、消息数 = 原话题当前分支条数（3）、副本内无分支标记、活动节点指向末条消息；`pending/streaming` 归一为 `cancelled` |
| 标签页/头部指示 | 通过 | 含分支的话题在列表显示分支图标；顶栏「分支 N」徽标显示整棵消息树的节点数 |
| 代码块复制 | 通过 | 代码块顶部显示语言与「复制」按钮，点击后剪贴板为纯代码文本（106 字符 Go 片段：无语言标记、无尾部换行、不含正文其它内容），按钮 1.6 秒内显示「已复制」并弹「已复制」提示；行内代码不出现按钮 |
| 代码块语法高亮 | 通过 | `rehype-highlight` 生效：Go 块 10 个、Python 块 14 个 `hljs-*` token（关键字/函数名/参数/注释/字符串/数字），颜色取自 tokens 的 `--syntax-*`（浅色 `lab(38.77 44.4 -58.5)`、深色 `lab(72.7 28.3 -38.7)`，注释两套均为斜体灰）；未知语言（`mylang`）保持纯文本、无 token 无报错；行内代码不加 `.hljs`；高亮后复制仍得到纯代码（101 字符 Python 片段，无 span 残留）；前端产物 827KB → 996KB（gzip ≈ +50KB） |
| 复制到剪贴板（导出） | 通过 | 剪贴板内容 = 完整 Markdown（1251 字符，`# 标题` + 助手/时间/消息数 + `### 用户/助手` 分节 + `<details>思考过程</details>`） |
| 另存为 .md | 通过 | 原生保存对话框弹出（窗口标题「导出为 Markdown」）；输入路径后写入 `temp/export-smoke.md`（3285 字节、UTF-8、3 个消息分节、3 个 `---` 分隔），默认文件名导出亦成功（`没有什么能力（副本）-20260919-141150.md`，3297 字节） |
| 保存对话框取消 | 通过 | 按 Esc 关闭对话框后绑定返回 `{Saved:false, FileName:'cancel-test.md'}`，界面提示「已取消保存」，无报错 |
| 质量门禁 | 通过 | `pnpm --dir frontend typecheck`、`go build ./...`、`go vet ./...`、`wails build -clean -trimpath -platform windows/amd64` 全部通过 |

已知限制（原型取舍，方案 §24.5）：消息树一次性返回整条活动分支与整棵树（上限 2000 条，不做分页）；
删除消息不级联清理子节点；导出只包含当前分支、不含图片二进制。

## 8. 已修复缺陷（2026-09-19）

| 现象 | 根因 | 修复 | 证据 |
| --- | --- | --- | --- |
| 长回答（推理模型）流式中途报「生成失败：Maximum update depth exceeded ... chat-failed」 | `MessageItem` 的「文本变化 → 同步编辑草稿」`useEffect` 在**编辑框未打开时也对每个流式增量 setState**（每个 delta 一次 `setDraft`）。上游把大量分片一次性推进前端时，React 判定为嵌套更新循环并抛 error #185，异常被 `runChat` 捕获后写成 `chat-failed` 错误片段 | 该 effect 增加 `if (!editing) return`（并纳入依赖），只在编辑框打开时才动状态；其它流式路径不再有逐 delta 的 setState | A/B 复现：桩驱动「长推理 + 长正文、1 字符增量、单任务内一次性投递」时，旧代码稳定复现同一 React 报错（生产构建为 minified #185），修复后 dev/生产构建均无报错；编辑框打开仍能预填文本 |

该缺陷属前端渲染层，与模型/Provider 无关；模型侧只是把大量增量推得快，暴露了逐增量 setState 的写法。

