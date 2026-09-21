import { useMemo } from 'react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { appApi } from '../../../bridge/appApi'
import { useUiStore } from '../../../app/uiStore'
import { CodeBlock, extractCode } from './CodeBlock'
import { MermaidBlock } from './MermaidBlock'

/* 消息 Markdown 渲染：不启用 rehype-raw，raw HTML 一律按纯文本对待；
   URL 只放行 http/https，`img` 直接返回 null（方案 §14.5：普通 Markdown 图片不渲染）。
   代码块由 CodeBlock 接管：语言标记 + 「复制」按钮；语法高亮用 rehype-highlight（
   highlight.js 内核，同步、离线；颜色映射见 styles/markdown.css 的 .hljs-* 规则）。
   ```mermaid 围栏交给 MermaidBlock（懒加载 mermaid），其余围栏仍走高亮代码块。 */

const urlTransform: UrlTransform = (url, key) => {
  // 只处理链接类属性；其余属性原样返回给 react-markdown 默认处理
  if (key !== 'href') return url
  return /^https?:\/\//i.test(url) ? url : ''
}

function buildComponents(streaming: boolean): Components {
  return {
    img: () => null,
    pre: ({ children }) => {
      const { code, lang } = extractCode(children)
      if (lang.toLowerCase() === 'mermaid') return <MermaidBlock code={code} streaming={streaming} />
      return <CodeBlock>{children}</CodeBlock>
    },
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
}

export function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // components 依赖 streaming：流结束时必须换一份引用，让 MermaidBlock 立刻出最后一次图
  const components = useMemo(() => buildComponents(streaming), [streaming])

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
