import { useEffect, useRef, useState, isValidElement, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyToClipboard } from '../chatStore'

/* 代码块渲染：语言标记 + 「复制」按钮。语法高亮由 MarkdownText 的 rehype-highlight
   提前写好（children 是高亮子树），本组件只负责容器外观与复制行为。 */

/** 从 `<pre>` 的子树里取出代码正文与语言标记（react-markdown 只给到 React 节点）。 */
export function extractCode(children: ReactNode): { code: string; lang: string } {
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

export interface CodeBlockProps {
  /** react-markdown 的高亮子树（常规路径） */
  children?: ReactNode
  /** 纯文本正文；与 children 二选一，供 MermaidBlock 回退渲染使用 */
  code?: string
  /** 纯文本正文对应的语言标记（code 存在时有效） */
  lang?: string
}

export function CodeBlock({ children, code, lang: langProp }: CodeBlockProps) {
  // code 存在时说明调用方已经知道正文与语言，无需再从子树里猜
  const { code: text, lang } =
    typeof code === 'string' ? { code, lang: langProp ?? '' } : extractCode(children)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  function handleCopy(): void {
    void copyToClipboard(text)
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
      {/* 纯文本路径补一层 <code>，让字体与 .md pre code 的排版规则和常规路径一致 */}
      <pre className="md-code__pre">{typeof code === 'string' ? <code>{code}</code> : children}</pre>
    </div>
  )
}
