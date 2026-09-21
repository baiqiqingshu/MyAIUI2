import { useEffect, useId, useRef, useState } from 'react'
import type { Mermaid } from 'mermaid'
import { useUiStore } from '../../../app/uiStore'
import { CodeBlock } from './CodeBlock'

/* Mermaid 图表：mermaid 体积大且只有出现 ```mermaid 围栏时才需要，
   因此用动态 import 懒加载，首屏 chunk 里只留下本组件的空壳。 */

/** 超过这个长度基本不是给人看的图，放弃渲染以免长时间占用主线程。 */
const MAX_CODE_LENGTH = 20000
/** 流式期间每个分片都解析会反复失败抖动，等它稳定下来再渲染。 */
const STREAMING_DEBOUNCE_MS = 600

/** 懒加载结果缓存：多个代码块共享同一次网络请求。 */
let mermaidPromise: Promise<{ default: Mermaid }> | null = null
/** mermaid 的配置是模块级单例，同一主题下不必重复初始化。 */
let initializedTheme: 'dark' | 'default' | null = null

function loadMermaid(): Promise<{ default: Mermaid }> {
  if (!mermaidPromise) mermaidPromise = import('mermaid')
  return mermaidPromise
}

function ensureInitialized(mermaid: Mermaid, theme: 'dark' | 'default'): void {
  if (initializedTheme === theme) return
  mermaid.initialize({
    startOnLoad: false,
    // strict：标签交给 DOMPurify 清洗；配合顶层 htmlLabels:false，所有图表类型都不用 HTML 标签
    securityLevel: 'strict',
    htmlLabels: false,
    theme,
    fontFamily: 'inherit',
  })
  initializedTheme = theme
}

/** mermaid 渲染失败时会把临时容器留在 body 上（#d{id} 与挂载点 #{id}），清掉以免污染全局。 */
function cleanupTempNodes(id: string): void {
  document.getElementById(`d${id}`)?.remove()
  document.getElementById(id)?.remove()
}

/** 主题是应用级设置：system 时跟随系统偏好，并在系统切换时重新出图。 */
function useIsDarkTheme(theme: string): boolean {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return systemDark
}

export function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const theme = useUiStore((s) => s.settings.Theme)
  const dark = useIsDarkTheme(theme)
  // useId 的产物带 «» 等装饰字符，不能直接当 DOM id 用
  const baseId = `mmd${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  // 递增 token：慢渲染返回时若 token 已变，说明代码又更新过，结果作废
  const tokenRef = useRef(0)
  // 每次渲染用一个新 id：mermaid.render 会先删掉同 id 的既有节点（包括我们自己注入的 svg），
  // 换成新 id 后旧图能留到新图就绪，也不会出现「状态没变、React 跳过 innerHTML 更新」的空容器
  const runRef = useRef(0)

  useEffect(() => {
    if (code.length > MAX_CODE_LENGTH) {
      tokenRef.current += 1
      setSvg('')
      setError('Mermaid 代码过长，已显示源码')
      return
    }
    let cancelled = false
    const token = (tokenRef.current += 1)
    const renderId = `${baseId}-${(runRef.current += 1)}`

    async function render(): Promise<void> {
      try {
        const mermaid = (await loadMermaid()).default
        ensureInitialized(mermaid, dark ? 'dark' : 'default')
        // 先 parse 再 render：parse 只做语法校验，不会往 DOM 里塞半成品
        await mermaid.parse(code)
        const result = await mermaid.render(renderId, code)
        if (cancelled || token !== tokenRef.current) return
        setSvg(result.svg)
        setError('')
      } catch {
        // 无论结果是否已过期都要清：过期渲染留下的临时节点没人会再处理
        cleanupTempNodes(renderId)
        if (cancelled || token !== tokenRef.current) return
        setSvg('')
        // 流式期间语法本来就不完整，此时报错只是噪音，等流结束再提示
        setError(streaming ? '' : 'Mermaid 渲染失败，已显示源码')
      }
    }

    if (streaming) {
      const timer = window.setTimeout(() => void render(), STREAMING_DEBOUNCE_MS)
      return () => {
        cancelled = true
        window.clearTimeout(timer)
      }
    }
    // 流已结束：立刻出图（有 token 兜底，卸载后不会再 setState）
    void render()
    return () => {
      cancelled = true
    }
  }, [code, streaming, dark, baseId])

  // error 非空时即便还留着上一张图也显示源码，保证画面与当前代码一致
  if (svg !== '' && error === '') {
    // SVG 由 mermaid 在 strict 安全级别下生成并经 DOMPurify 清洗，不是模型输出的原始 HTML
    return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
  }
  return (
    <div className="md-mermaid md-mermaid--fallback">
      {error ? <p className="md-mermaid__notice">{error}</p> : null}
      <CodeBlock code={code} lang="mermaid" />
    </div>
  )
}
