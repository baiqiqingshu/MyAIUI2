# Vercel 自动部署（单 HTML Web 版）

目标：把 `frontend/dist-web/index.html`（`pnpm --dir frontend build:web` 产出的单文件应用，见 [SINGLE_HTML_WEB.md](SINGLE_HTML_WEB.md)）通过 GitHub 仓库自动部署到 Vercel——push 到 `main` 即发布生产版本，其他分支/PR 自动生成预览环境。

## 仓库侧已就绪的配置

| 文件 | 作用 |
| --- | --- |
| `frontend/vercel.json` | 以 `frontend/` 为项目根时的 Vercel 配置：`pnpm install` → `pnpm build:web` → 输出 `dist-web`；`framework: null` 按纯静态站托管。`ignoreCommand` 使与 `frontend/` 无关的提交（纯 Go 改动等）不触发部署 |
| `frontend/api/proxy.ts` | 通用 HTTP 代理 Edge Function（`/api/proxy?url=<目标>`，Vercel 自动构建 `api/` 目录）。前端外联请求可经它同源中转（「模型服务 → 部署端中转」开关默认关，开启后生效），不受 provider CORS 策略限制；按主机名拦内网地址，可用环境变量 `PROXY_ALLOWED_HOSTS`（逗号分隔域名后缀）配置白名单 |
| `frontend/package.json` 的 `engines` | 声明 `node >=22.12.0`（Vite 8 要求），供 Vercel 选择 Node 版本 |

## 一次性设置

1. 把本仓库推到 GitHub。
2. Vercel 控制台 → **Add New… → Project** → 选中该仓库 **Import**。
3. 导入页会提示 "Multiple applications detected"——这是因为 Vercel 自动探测到仓库根的 `go.mod`，把 Wails 桌面壳列成了 `app · Go` 服务。**桌面 Go 壳不是 Web 服务，忽略它**。
4. 在 **`frontend`（Vite）那一行点 "Import single project"**，Root Directory 自动设为 `frontend`。Vercel 读到 `frontend/vercel.json` 后自动使用 `pnpm build:web` / `dist-web`，无需手改，直接 **Deploy**。
5. 完成。此后：
   - `git push` 到 `main` → 生产部署 `https://<project>.vercel.app`
   - 其他分支 / PR → 自动预览部署，URL 出现在 PR 与 Vercel 面板上

## 本地预演（与 Vercel 执行的命令一致）

```powershell
pnpm --dir frontend install
pnpm --dir frontend build:web     # → frontend/dist-web/index.html
```

`frontend/dist-web/` 已在 `.gitignore` 中，产物不提交，由 Vercel 每次现构建。

## 注意

- Web 版密钥明文存浏览器 localStorage、模型请求可经 `/api/proxy` 中转 provider（开关默认关）——与单文件版同一套取舍，部署到公网只是换了访问方式，安全性不变；但 URL 默认公网可达，建议在 Vercel 项目设置里按需开启 Deployment Protection（也可避免代理被第三方当公共转发滥用）。
- 部署产物是「单个 index.html 静态站 + 一个 Edge 代理函数」；任何把数据存到远端的需求都不在本方案范围内。
