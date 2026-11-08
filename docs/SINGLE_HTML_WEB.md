# 单 HTML Web 版实施方案

状态：已完成（原型）。构建命令 `pnpm --dir frontend build:web` → `frontend/dist-web/index.html`（单文件 ~6.4MB，含全部依赖），双击或任意静态服务打开即可使用。
目标：在不影响现有 Wails 桌面端的前提下，新增一条构建管线，产出**单个 .html 文件**，双击即可在浏览器里使用同一套 AI 对话工具；全部数据（助手/话题/消息/Provider/密钥/设置）存浏览器 localStorage。

## 1. 运行时架构

现有前端只经两个收口触达后端，桌面端不变，新增"浏览器后端"与之并列：

```
UI / features / lib/ai
   ├── bridge/appApi.ts          —— 运行时二选一：
   │     window.go?.api?.AppAPI 存在 → Wails 绑定（现状，桌面端）
   │     否则                        → bridge/web/webApi.ts（localStorage 实现）
   └── lib/ai/providerFactory.ts —— fetch 二选一：
         Wails → createWailsFetch（Go 受限 Transport，现状）
         Web   → bridge/web/webFetch.ts（浏览器直连 provider，注入 Authorization）
```

- 运行时判定只看 `window.go?.api?.AppAPI` 是否存在，不做 build-time 差异代码；
  桌面端 `pnpm build` / `wails build` 路径完全不受影响。
- `vite dev` 无 `window.go` → 自动落入 web 模式，等于顺带获得浏览器调试路径。

## 2. 新增文件（frontend/src/bridge/web/）

| 文件 | 职责 |
| --- | --- |
| `db.ts` | localStorage 读写。两个 key：`myaiui2.web.v1.db`（全量业务数据 JSON，写穿透）与 `myaiui2.web.v1.secrets`（provider/search 明文密钥）。集合：settings/assistants/providers/models/topics/folders/messages。提供 `load()`、`mutate(fn)`、`getProviderKey(id)`、`getSearchKey()` |
| `webApi.ts` | 实现 `AppApi` 全部方法，语义逐一对齐 `internal/api/*.go`（见 §4 契约） |
| `webFetch.ts` | `createWebFetch(provider): typeof fetch`：直连 `provider.BaseURL + path`，注入 `Authorization: Bearer <localStorage 密钥>`；空密钥不注入 |
| `markdown.ts` | 话题导出 Markdown 渲染，对齐 `internal/api/topic_export.go` |
| `index.ts` | 导出 `webApi`、`createWebFetch` |

## 3. 修改文件

| 文件 | 改动 |
| --- | --- |
| `frontend/src/bridge/appApi.ts` | `call()` 内分派：无 `window.go` 时把方法名转发给 `webApi[method]`；`appApi` 外观签名不变，调用方零改动 |
| `frontend/src/lib/ai/providerFactory.ts` | `createProvider` 内按运行时选 `createWailsFetch(provider.ID)` 或 `createWebFetch(provider)` |
| `frontend/vite.web.config.ts`（新增） | Web 构建：outDir `dist-web`，WEB_CSP，`inlineDynamicImports` + 单文件内联插件 |
| `frontend/package.json` | 新增 `build:web` 脚本 |
| `.gitignore` | 忽略 `frontend/dist-web/` |

## 4. webApi 语义契约（对齐 Go 侧，原型可简化处已注明）

- **Bootstrap**：种子化预置助手（`internal/api/app_api.go:365` 的 4 个内置助手，含一次性播种标记）、保证活动助手 ≥1、每助手话题 ≥1（默认标题「新话题」）、返回 BootstrapDTO（AppName `MyAIUI2`、Version `0.1.0-prototype-web`）。
- **消息树/分支**：ParentID 链 + SortOrder（同一话题内单调递增序号）；`activePath` = 从 `topic.ActiveNodeID` 沿 ParentID 回溯到根；`SiblingIndex/SiblingCount` = 同一 ParentID 下按 SortOrder 的兄弟序号；`HasBranches` = 存在任一父节点有 >1 子。
- **StartTurn**：新建 user(done) + assistant(streaming, ParentID=新 user) 两条消息；user 挂到当前活动路径末端；活动节点指向 assistant 占位；话题为空标题/「新话题」时取用户文本前 30 字自动命名（换行→空格）；返回 TurnDTO（History = user 之前的路径）。
- **StartAssistantMessage**：仅可对 user 消息生成；新 assistant 兄弟变体（ParentID=该 user）；History = 到该 user 的路径去掉 user 本身。
- **EditAndResendUserMessage**：新 user 兄弟变体 + 其下新 assistant 占位；活动节点切换。
- **FinishTurn/SaveTurnSnapshot**：更新 PartsJSON/Status（status: done/error/cancelled）。
- **SetActiveNode** / **SwitchToBranch**（沿「SortOrder 最大子节点」下探至叶）/ **GetTopicTree**（DFS、OnActivePath、Preview 取首条 text 截断）：对齐 `app_api.go:1594-1740`。
- **DeleteMessage**：级联删子树；活动节点在被删子树内则回退到父。
- **话题/目录**：Zone '' / 'fav' 两区；SortOrder 容器内下标；MoveTopic/MoveTopicFolder 重排，对齐 `topic_org.go`；DeleteTopic 级联删消息；DuplicateTopic 复制活动路径为新话题。
- **Provider/Model**：SaveProvider 走 `secrets` 存密钥、`HasAPIKey` 镜像；TestProvider = GET `{BaseURL}{ModelPath||/v1/models}` 判连通；SyncProviderModels = 拉模型列表 upsert + 标 MissingRemote；CopyProviderAPIKey → `navigator.clipboard`。
- **导出**：ExportTopicMarkdown 渲染活动分支；SaveTopicMarkdown 触发浏览器下载 `.md`。
- **Search**：直连 searxng `{BaseURL}/search?q=&format=json&language=zh-CN`，对齐 `transport/search.go`；CORS 失败按错误返回。
- **LoadRemoteImage**：fetch → base64 data（限 http/https，对齐 `remote_image.go` 校验）。
- **Relay/Proxy**：GetRelayStatus 恒 `{Enabled:false,Running:false}`、SetRelayEnabled 返回同状态；ProxySettings 仅存不生效（浏览器无代理控制）。
- **OpenExternalURL** → `window.open(url, '_blank', 'noopener')`。
- **简化许可**：跳过 UUID 严格校验等输入校验（UI 已保证），错误消息保持中文。

## 5. 单文件构建

- `vite.web.config.ts`：`base './'`、`target es2022`、outDir `dist-web`、`modulePreload:false`、`cssCodeSplit:false`、`rollupOptions.output.inlineDynamicImports:true`、`assetsInlineLimit` 拉满；
  自定义 ~40 行 `singleFile` 插件在 `closeBundle`/`generateBundle` 把 `<script src>`→内联、`<link stylesheet>`→`<style>`，删除多余资产文件（不新增依赖）。
- `index.html` 复用，`%CSP%` 在 web 构建替换为：
  `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; font-src 'self' data:; connect-src https: http:; object-src 'none'; base-uri 'none'; worker-src 'self' blob:`
  （`script-src 'unsafe-inline'` 是单文件内联的前提；`connect-src` 放开到任意 http(s) 因为 provider 地址用户自配）
- `pnpm build:web` → `frontend/dist-web/index.html`，直接双击用。

## 6. 实现说明（落地时与 §2-§5 的差异）

- `singleFile` 插件的 `generateBundle` 需要 `order: 'post'`：Vite 8（rolldown）在它自己的 `generateBundle` 才发出 index.html asset，默认顺序读不到。
- Vite 8 警告 `inlineDynamicImports` 已弃用（建议 `codeSplitting: false`），当前仍生效，后续可换 `rolldownOptions.output.codeSplitting: false`。
- webApi 实际落地为 ~2100 行单文件 + db/markdown/webFetch 三个辅助文件，51 个 AppApi 方法全覆盖；
  Bootstrap 在 web 下每次调用都会把残留 streaming 消息标记为 interrupted（Go 仅在进程启动时做一次，语义等价）。
- `vite dev` 没有 `window.go`，自动落入 web 模式——顺带获得免 Wails 的浏览器调试路径。

## 7. 已知取舍（原型）

- 密钥明文存 localStorage：单文件无后端可托管密钥，属预期；文档注明风险。
- CORS：浏览器直连要求 provider 端允许跨域；不支持 CORS 的端点会报网络错误（桌面端无此限制）。
- localStorage ~5MB 上限，图片以 base64 存消息里会较快占满；原型接受，后续可换 IndexedDB。
- 中转（relay.py）与代理设置在 web 版不生效。
