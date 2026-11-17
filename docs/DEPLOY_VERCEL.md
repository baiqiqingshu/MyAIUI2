# Vercel 自动部署（单 HTML Web 版）

目标：把 `frontend/dist-web/index.html`（`pnpm --dir frontend build:web` 产出的单文件应用，见 [SINGLE_HTML_WEB.md](SINGLE_HTML_WEB.md)）通过 GitHub 仓库自动部署到 Vercel——push 到 `main` 即发布生产版本，其他分支/PR 自动生成预览环境。

## 仓库侧已就绪的配置

| 文件 | 作用 |
| --- | --- |
| `vercel.json` | 声明 `installCommand`/`buildCommand`/`outputDirectory`：`pnpm --dir frontend install` → `pnpm --dir frontend build:web` → 输出 `frontend/dist-web`；`framework: null` 关闭框架自动探测，产物按纯静态站托管。`ignoreCommand` 使与 `frontend/` 无关的提交（纯 Go 改动等）不触发部署 |
| `package.json`（根） | 仅声明 `engines.node >=22.12.0`（Vite 8 要求），供 Vercel 选择 Node 版本；不是真实 npm 工程，本地开发仍在 `frontend/` 内操作 |

## 一次性设置

1. 把本仓库推到 GitHub（私有仓库亦可，Vercel 免费版可部署私有仓库）。
2. Vercel 控制台 → **Add New… → Project** → 选中该仓库 **Import**。
3. 保持默认（Root Directory 留仓库根，不要改）：Vercel 读到 `vercel.json` 后会自动填入 Build/Install/Output 配置，直接 **Deploy**。
4. 完成。此后：
   - `git push` 到 `main` → 生产部署 `https://<project>.vercel.app`
   - 其他分支 / PR → 自动预览部署，URL 出现在 PR 与 Vercel 面板上

## 本地预演（与 Vercel 执行的命令一致）

```powershell
pnpm --dir frontend install
pnpm --dir frontend build:web     # → frontend/dist-web/index.html
```

`frontend/dist-web/` 已在 `.gitignore` 中，产物不提交，由 Vercel 每次现构建。

## 注意

- Web 版密钥明文存浏览器 localStorage、模型请求直连 provider（受 CORS 约束）——与单文件版同一套取舍，部署到公网只是换了访问方式，安全性不变；但 URL 默认公网可达，建议在 Vercel 项目设置里按需开启 Deployment Protection。
- 部署产物是「单个 index.html 的静态站」，无服务端能力；任何把数据存到远端的需求都不在本方案范围内。
