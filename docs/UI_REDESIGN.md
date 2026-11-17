# 前端视觉重设计 + 模型服务页交互修复 — 实施文档

日期：2026-11-18 ｜ 范围：`frontend/src`（Wails 桌面端与单 HTML Web 版共用同一份样式）

参考：`.agents/skills/impeccable`（Operate 模式：克制、精确、可扫读）+ `.agents/skills/ui-ux-pro-max`（--design-system 输出：Glassmorphism 风格、蓝色系 #2563EB 主色、SVG 图标、150–300ms 过渡）。

## 设计方向

**模式**：Operate（工具型桌面应用）——野心体现在精度与克制，不做营销式炫技。

**参考风格**（用户供图）：B 端后台 dashboard——
- **冷灰画布 + 白色大圆角卡片悬浮**：app 底色是带一点蓝紫倾向的浅冷灰（≈#F1F2F6），卡片纯白、`radius 14–16px`、几乎无边框、极柔和弥散阴影。
- **左侧图标导航栏**：白色/浅底竖栏 + 圆形图标按钮，active 态高亮。
- **pill 控件**：开关、标签、切换器、小按钮大量用胶囊形。
- **pastel 强调色**：主色走现代蓝紫（indigo/blue-violet，≈#2563EB~#4F46E5 档）；辅助 pastel 浅底（accent-soft 低饱和浅紫蓝）做选中/气泡/徽标底色。
- 大量留白、分组清晰；小字 muted label + 正文主色。

**视觉语言**（用户指定）：
- 柔和弥散阴影：多层、低透明度、大模糊半径的阴影叠加；禁止硬偏移阴影。
- 卡片悬停上浮：`translateY(-1px~-2px)` + 阴影加深，120–180ms ease-out。
- 渐变仅用于：品牌区（助手栏顶部品牌块/栏顶淡染）、聚焦态光晕、导航局部点缀。**按钮一律纯色，禁止渐变**（去 AI 感）。
- 磨砂玻璃：浮层与顶栏用 `backdrop-filter: blur + saturate` + 半透明底色；提供 `@supports` 回退为实色。
- 中文文案（沿用现有文案）、SVG 图标（lucide-react，已在用）、圆角卡片/按钮。
- 隐藏组件同样设计：自绘下拉选项弹层、Modal/Drawer/Toast、checkbox、range 滑块、滚动条、选区色。

**Token 契约**：`styles/tokens.css` 变量名冻结（上游 Cherry Studio 语义映射），只允许调数值、新增变量，禁止另起命名体系。

## 关键改动清单

### 1. tokens.css（基础，Agent A）
- **画布/卡片分色**（参考图核心）：`--bg-app` 浅色改为带蓝紫倾向的冷灰 ≈`oklch(0.965 0.006 260)`；`--bg-panel`/`--bg-elevated` 纯白；`--bg-sidebar` 用白或极浅灰（比 app 亮，靠 hairline 分隔）。深色模式：app 深灰、panel 略亮一档的既有层级保持。
- accent 改现代蓝紫：浅色 ≈`oklch(0.55 0.20 268)`（≈#4F46E5~#2563EB 档），hover 更深一档；`accent-soft` 为低饱和浅紫蓝 pastel；`accent-text` 同步。深色 accent ≈`oklch(0.72 0.15 268)`。
- 圆角放大：`--radius-sm: 6px`（保留）、`--radius-md: 10px`、`--radius-lg: 14px`、新增 `--radius-xl: 18px`（弹层/输入区卡片）、`--radius-full` 保留（pill/开关/徽标）。
- 阴影改柔和弥散多层：
  - `--shadow-sm`: `0 1px 2px rgb(0 0 0/.05)`
  - `--shadow-md`(卡片常态): `0 1px 2px rgb(0 0 0/.04), 0 4px 16px -4px rgb(0 0 0/.07)`
  - 新增 `--shadow-lift`(悬停): `0 4px 8px -2px rgb(0 0 0/.05), 0 14px 32px -8px rgb(0 0 0/.12)`
  - `--shadow-lg`(弹层): `0 8px 24px -8px rgb(0 0 0/.16), 0 2px 6px rgb(0 0 0/.06)`
  - 深色模式相应加重（沿用现有比例）。
- 新增玻璃变量：`--glass-bg: color-mix(in oklch, var(--bg-elevated) 72%, transparent)`、`--glass-bg-header: color-mix(in oklch, var(--bg-app) 70%, transparent)`、`--glass-blur: blur(16px) saturate(1.4)`。
- 新增动效变量：`--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`、`--dur-fast: 0.12s`、`--dur-med: 0.18s`。
- 主按钮纯色（禁渐变）；边框整体变淡——白色卡片在灰画布上主要靠阴影分层的，border 可用 `--border-subtle` 或去掉。

### 2. UI primitives（components/ui，Agent A）
- Button：纯色填充；primary=实色 accent + hover 略深 + 轻微上浮阴影；secondary=面板底+边框；ghost/danger 沿用。高度/尺寸 API 不变。
- Input/Textarea：边框略柔和，focus = accent 边 + `--accent-ring` 光晕。
- **新自绘 `Select`**：替换原生 `<select>`。Props 兼容现有 `{value, onChange, options, disabled, placeholder}`，并新增可选 `groups?: { label: string; options: SelectOption[] }[]`（分组渲染组头）。触发钮样式同 Input；弹层向下展开（`position:absolute; top:calc(100%+6px)`），玻璃底、圆角 `radius-md`、选项 hover/选中态（选中右侧 ✓）、点击外部与 Esc 关闭、`max-height` 滚动。参考 `features/chat/ModelSelect.tsx` 的现成模式（向上弹层是因其在窗口底部）。z-index 需高于卡片。
- Toggle：滑块加微阴影、过渡用 `--ease-out`。
- Modal/Drawer/ConfirmDialog：`radius-xl` + 玻璃底 + pop/slide 动画保留。
- Toast：玻璃底 + `radius-md`。
- range input（`.as-edit__range`）：补 track/thumb 样式（accent 拇指、圆角 track）。

### 3. 模型服务页重构（Agent B — 修复"反人类"交互）
- **展开位置修复**：服务商卡片头重排为 `[chevron] [图标] [名称+url+meta行] … [测试][编辑][删除] [Toggle]`：
  - chevron 移到卡片头**最左**（`ChevronRight`→展开转 `ChevronDown`，或 rotate 90° 动画）。
  - 整个 head 区域可点击切换展开（内部按钮/开关 stopPropagation）。
  - meta（模型数/最近同步/密钥已配置）并入名称块第二行（紧跟 url 之后的小字行）或保留独立行但仍在 head 内。
  - 操作按钮（测试连接/编辑/删除）改为头部右侧紧凑 IconButton（`Zap`/`Pencil`/`Trash`，title 提示；测试保留 loading 态——IconButton 无 loading prop，可用局部 spinner 或保留小 Button，自洽即可）。
  - 展开后 `ModelList` 紧跟 head 渲染，中间不再隔 meta/actions 行。
- **模型批量删除**：批量条加「删除所选（N）」danger 按钮 → ConfirmDialog（"手动添加的模型删除后不可恢复，远端模型可再同步找回"）；`Promise.allSettled(appApi.DeleteModel)`，报成功/失败数；成功项从勾选集移除（失败保留便于重试）。
- providers.css：卡片 `radius-lg`、hover 上浮、model-row 精修、批量条分组感。

### 4. 对话区（Agent C）
- chat-header：磨砂玻璃（半透明 + blur），底部分隔保留。
- **输入区合并为一张圆角卡片**：工具行（ModelSelect+联网）+ textarea（内部去边框）+ 底行（hint+发送）包进同一 `border+radius-xl` 容器，`focus-within` 时 accent 边+光环；顶部 resize 把手保留（TextComposer 的 `rootRef.querySelector('textarea')` 与拖动逻辑必须继续工作）。
- 用户气泡、消息操作按钮、批量选择条（玻璃化）、model-select 弹层（玻璃+选项态）、search-toggle、错误卡、小点导航预览 — 全部按新 token 精修。
- ChatWorkspace.tsx/TextComposer.tsx 仅做必要的 className/结构调整，不改行为。

### 5. 导航与面板（Agent D）
- 助手栏顶部新增品牌块：小尺寸渐变圆角方块（accent→accent-hover 对角渐变 + 白色 lucide `Bot` 或同类产品图标），其下栏顶可做极淡 accent-soft 渐变染区——**全局仅此两处渐变**。
- rail item：active 态左侧渐变指示条或 accent-soft 底；hover 微浮。
- AssistantEditor：原生 `<select>`（默认模型，含 optgroup 分组）迁移到新 `Select` 的 `groups` API。
- topics.css/branches.css/images.css：active 指示条、目录行、分支行、导出预览随新 token 精修。

### 6. markdown.css / scrollbar.css
- 代码块加边框+`radius-lg`（保留 header 栏若有）；表格/引用块检查补齐；滚动条保持现状（已精修）。

## 分工与验证

| Agent | 文件范围（互不重叠） |
|---|---|
| A 基础 | `styles/tokens.css`、`styles/global.css`、`styles/scrollbar.css`、`styles/markdown.css`、`components/ui/index.tsx`、`components/ui/ui.css` |
| B 服务商 | `features/providers/*`（.tsx + providers.css） |
| C 对话 | `features/chat/*`（chat.css + 必要 tsx）、`features/search/SearchResults.tsx` 如需 |
| D 导航面板 | `features/assistants/*`、`features/topics/*`、`features/branches/*`、`features/images/*`、`app/App.tsx` 如需 |

新 `Select` 的 API 契约以本文档为准，B/C/D 按契约写调用，A 按契约实现。

**验证**：`cd frontend && pnpm build`（= `tsc --noEmit && vite build`）必须过；视觉自查交给浏览器渲染抽查（如可运行 `pnpm dev` / wails dev，否则靠代码审查）。

## 禁区
- 变量名不得重命名/新增平行色系命名（tokens.css 顶部注释是冻结契约）。
- 按钮不加渐变；emoji 助手头像是用户数据，不替换。
- 不改 Go 后端与 appApi 契约；不改消息/状态逻辑。
- 玻璃浮层在 `backdrop-filter` 不支持时回退实色（`@supports`）。

## 完成记录（2026-11-18）

已按上述方案全部落地，4 个并行子任务交付、`tsc --noEmit` 0 错误、`vite build` 与 `vite build --config vite.web.config.ts` 均通过。

- **tokens.css**：`--bg-app` 冷灰画布、`--bg-sidebar` 极浅灰、accent 全族改蓝紫（浅 `oklch(0.55 0.2 268)` / 深 `oklch(0.72 0.15 268)`）；`--radius-md`→10px、`--radius-lg`→14px、新增 `--radius-xl`；阴影换柔和弥散多层并新增 `--shadow-lift`；新增 `--glass-bg`/`--glass-bg-header`/`--glass-blur`、`--ease-out`/`--dur-fast`/`--dur-med`（三套主题块同步）。
- **自绘 Select**：原生 `<select>` 全部替换（ProviderForm ×2、ModelList modality ×2、AssistantEditor 默认模型含分组）。API：`options` 与 `groups` 二选一 + `placeholder`/`className`；玻璃弹层向下展开、空间不足自动 `.is-up` 向上；空组头 label 不渲染组头。
- **模型服务页**：服务商卡片头重构——chevron 最左、整头可点（`role="button"` + Enter/Space + 右侧控件 stopPropagation）、meta 并入名称块第三行、操作收成头部 IconButton（Zap/Pencil/Trash，删除 hover danger）；`ModelList` 紧跟 head。卡片去 `overflow:hidden` 改圆角分区补齐，`:focus-within` 抬 z-index 防行内下拉被后卡盖住。展开区 `--bg-app` 冷灰 inset。
- **模型批量删除**：批量条新增「删除所选（N）」+ ConfirmDialog；`Promise.allSettled(DeleteModel)`，成功移出勾选、失败保留，toast 报成/败数。
- **对话区**：chat-header 磨砂玻璃；输入区合并为 `.chat-composer__card` 圆角白卡（focus-within accent 环），resize 拖动条在卡片外逻辑不变；model-select 弹层/select-bar/dots 预览玻璃化；用户气泡 pastel accent-soft。
- **导航**：助手栏顶部渐变品牌块（`Bot` 图标 + accent→accent-hover 135° 渐变 + 栏顶淡染）、圆形 item + 左缘渐变指示条；话题/分支 active 态同步 pastel + 渐变左条。
- **其他**：markdown 引用块改中性左边条、表格补 hairline；温度 range 双引擎自绘；Toast/Modal/Drawer 玻璃 + radius-xl；按钮零渐变（全 app 渐变仅：品牌块、rail/话题选中指示条）。

遗留：`docs/IMPLEMENTATION_PLAN.md` 为历史规划文档未更新；`MANUAL_SMOKE_TEST.md` 中「助手默认模型下拉」等原生 select 描述以新实现为准。
