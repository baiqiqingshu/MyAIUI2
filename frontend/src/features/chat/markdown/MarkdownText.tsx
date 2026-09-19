import { useEffect, useRef, useState, isValidElement, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { appApi } from '../../../bridge/appApi'
import { useUiStore } from '../../../app/uiStore'
import { copyToClipboard } from '../chatStore'

/* 消息 Markdown 渲染：不启用 rehype-raw，raw HTML 一律按纯文本对待；
   URL 只放行 http/https，`img` 直接返回 null（方案 §14.5：普通 Markdown 图片不渲染）。
   代码块由 CodeBlock 接管：语言标记 + 「复制」按钮；语法高亮用 rehype-highlight（
   highlight.js 内核，同步、离线；颜色映射见 styles/markdown.css 的 .hljs-* 规则）。 */

const urlTransform: UrlTransform = (url, key) => {
  // 只处理链接类属性；其余属性原样返回给 react-markdown 默认处理
  if (key !== 'href') return url
  return /^https?:\/\//i.test(url) ? url : ''
}

/** 从 `<pre>` 的子树里取出代码正文与语言标记（react-markdown 只给到 React 节点）。 */
function extractCode(children: ReactNode): { code: string; lang: string } {
  let code = ''
  let lang = ''
  const walk = (node: ReactNode): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      code += String(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (isValidElement(node)) {
      const props = node.props as { className?: string; children?: ReactNode }
      if (!lang && typeof props.className === 'string') {
        const matched = /language-([\w+#.-]+)/.exec(props.className)
        if (matched) lang = matched[1]
      }
      walk(props.children)
    }
  }
  walk(children)
  // 代码块正文末尾的总换行由 Markdown 语法带来，复制时去掉（与主流客户端一致）。
  return { code: code.replace(/\n$/, ''), lang }
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const { code, lang } = extractCode(children)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  function handleCopy(): void {
    void copyToClipboard(code)
    setCopied(true)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="md-code">
      <div className="md-code__bar">
        <span className="md-code__lang">{lang || 'text'}</span>
        <button
          type="button"
          className="md-code__copy"
          title="复制代码"
          aria-label="复制代码"
          onClick={handleCopy}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="md-code__pre">{children}</pre>
    </div>
  )
}

const components: Components = {
  img: () => null,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => {
    if (!href) return <span>{children}</span>
    return (
      <a
        href={href}
        rel="noreferrer"
        onClick={(event) => {
          event.preventDefault()
          appApi.OpenExternalURL(href).catch(() => {
            useUiStore.getState().showToast('无法打开链接', 'error')
          })
        }}
      >
        {children}
      </a>
    )
  },
}

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // 只高亮带 language-xxx 的围栏块（不猜测语言），未知语言按纯文本原样输出。
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
