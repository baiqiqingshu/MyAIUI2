import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { devApiProxy } from './vite.devApiProxy.ts'

// 安全基线 §14.5：index.html 里的 %CSP% 占位符在构建时被替换。
// 生产 CSP 禁止远程脚本、object、frame；开发态额外放开 Vite HMR。
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "frame-ancestors 'none'",
].join('; ')

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ')

function csp(): Plugin {
  return {
    name: 'myaiui2-csp',
    transformIndexHtml(html, ctx) {
      return html.replace('%CSP%', ctx.server ? DEV_CSP : PROD_CSP)
    },
  }
}

export default defineConfig({
  plugins: [react(), csp(), devApiProxy()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
  },
})
