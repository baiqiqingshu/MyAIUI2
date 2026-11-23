import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { devApiProxy } from './vite.devApiProxy.ts'

// docs/SINGLE_HTML_WEB.md §5：单 HTML Web 版构建契约。
// script-src 'unsafe-inline' 是单文件内联的前提；connect-src 放开到任意 http(s)
// 因为 provider / searxng 地址由用户自行配置。dev/build 用同一套。
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "font-src 'self' data:",
  'connect-src https: http:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src 'self' blob:",
].join('; ')

function cspWeb(): Plugin {
  return {
    name: 'myaiui2-csp-web',
    transformIndexHtml(html) {
      return html.replace('%CSP%', WEB_CSP)
    },
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 把产物内联回 index.html：<script src> → 内联代码、<link stylesheet> → <style>，
// 已内联的 js/css 从 bundle 删除，dist-web/ 只剩 index.html（+ public/ 拷入的 favicon.svg）。
// 配合 inlineDynamicImports / cssCodeSplit:false / assetsInlineLimit 全内联，
// 正常只会有一个入口 chunk 和最多一个 css asset。
function singleFile(): Plugin {
  return {
    name: 'myaiui2-single-file',
    apply: 'build',
    // order:'post' —— index.html 由内置 build-html 插件在 generateBundle 阶段才发出，
    // 必须排在它之后才能读到 html asset 并把 js/css 内联进去。
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const htmlAsset = Object.values(bundle).find(
          (e) => e.type === 'asset' && e.fileName === 'index.html',
        )
        if (!htmlAsset || htmlAsset.type !== 'asset') {
          this.warn('singleFile: 未找到 index.html asset，跳过内联')
          return
        }

        let html = String(htmlAsset.source)
        const inlined: string[] = []

        for (const entry of Object.values(bundle)) {
          if (entry.type === 'chunk' && entry.fileName.endsWith('.js')) {
            // JS 中可能含 "</script>"（字符串/正则字面量），无条件转义防止提前闭合。
            const code = entry.code.replace(/<\/script>/g, '<\\/script>')
            const tagRe = new RegExp(
              `<script[^>]*\\bsrc="[^"]*${escapeRe(entry.fileName)}"[^>]*>\\s*</script>`,
            )
            if (tagRe.test(html)) {
              html = html.replace(tagRe, () => `<script type="module">\n${code}\n</script>`)
              inlined.push(entry.fileName)
            }
          } else if (entry.type === 'asset' && entry.fileName.endsWith('.css')) {
            const css = String(entry.source)
            const tagRe = new RegExp(
              `<link[^>]*\\bhref="[^"]*${escapeRe(entry.fileName)}"[^>]*/?>`,
            )
            if (tagRe.test(html)) {
              html = html.replace(tagRe, () => `<style>\n${css}\n</style>`)
              inlined.push(entry.fileName)
            }
          }
        }

        htmlAsset.source = html
        for (const name of inlined) delete bundle[name]

        for (const entry of Object.values(bundle)) {
          if (entry.fileName !== 'index.html') {
            this.warn(`singleFile: 产物中仍有未内联文件 ${entry.fileName}`)
          }
        }
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), cspWeb(), singleFile(), devApiProxy()],
  base: './',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: () => true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
