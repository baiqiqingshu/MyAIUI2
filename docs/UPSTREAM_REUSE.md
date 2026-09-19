# 上游复用台账（Cherry Studio）

- 上游仓库：`D:\WorkProject\3rd_github\Group_cli_agent\cherry-studio`
- 固定提交：`f236b74929f1683a23b3a808f57e5a9d53f0b1e8`（2026-09-18）
- 上游许可：AGPL-3.0（`LICENSE` 原样保留于本项目根目录）
- 规则：禁止从浮动 main 直接复制；每次复用都要在本文件登记「来源文件 → 目标文件 → 修改说明」。

## 复用策略（方案 §4.2）

| 级别 | 内容 | 本项目做法 |
| --- | --- | --- |
| A | CSS 色值、间距、圆角、阴影、滚动条、三栏比例 | 提取数值写入 `frontend/src/styles/tokens.css` |
| B | 低耦合纯展示组件 | 仅参考视觉，按本项目领域模型重写 |
| C | 助手栏/话题栏/消息气泡/输入器/模型选择器/Provider 配置 | 按外观重写，不复制源码 |
| D | HomePage、Topics、ChatComposer、MessageParts、Redux/Dexie、Electron main/preload、AI Core、Provider Registry | 禁止迁移 |

## 登记表

| 来源（上游路径） | 目标（本项目路径） | 复用级别 | 修改说明 |
| --- | --- | --- | --- |
| `packages/ui/src/styles/shadcn.css`、`packages/ui/src/styles/product.css` | `frontend/src/styles/tokens.css` | A | 提取语义色数值（background/card/popover/border/muted/foreground 等），重写为本项目变量名，未复制选择器 |
| `packages/ui/src/styles/tokens/colors/{primitive,providers,status-legacy}.css` | `frontend/src/styles/tokens.css` | A | 提取调色板数值；`--accent*` 取上游蓝色语义（blue-500/600/50，深色 blue-400/300/900），刻意避开标注为品牌专属色的 `cs-brand-*` |
| `packages/ui/src/styles/tokens/{radius,spacing}.css` | `frontend/src/styles/tokens.css`、`frontend/src/styles/global.css` | A | 圆角/间距刻度数值（radius-lg 采用上游 10px，面板宽采用上游 16rem=256px） |
| `src/renderer/assets/styles/markdown.css` | `frontend/src/styles/markdown.css` | A | 参考标题/引用/表格/行内代码版式；额外加入 `.md img { display: none }` 作为「Markdown 不渲染图片」兜底 |
| `src/renderer/assets/styles/scrollbar.css` | `frontend/src/styles/scrollbar.css` | A | 滚动条宽度与悬停加深行为 |

> 未复用：Cherry 名称、Logo、应用图标等品牌资产；任何 Electron/Redux/Dexie/Agent/MCP/知识库/文件相关源码。
> 阴影数值取自 Tailwind 的 `shadow-sm`/`shadow-lg` 刻度（上游未定义阴影 token，其组件直接使用 Tailwind 阴影）。

> 后续如新增复用，逐行追加；仅"参考交互与视觉后自行实现"的内容不构成源码复用，无需登记，但应在提交说明中注明。
