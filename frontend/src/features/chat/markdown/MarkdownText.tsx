import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { appApi } from '../../../bridge/appApi'
import { useUiStore } from '../../../app/uiStore'

/* 消息 Markdown 渲染：不启用 rehype-raw，raw HTML 一律按纯文本对待；
   URL 只放行 http/https，`img` 直接返回 null（方案 §14.5：普通 Markdown 图片不渲染）。 */

const urlTransform: UrlTransform = (url, key) => {
  // 只处理链接类属性；其余属性原样返回给 react-markdown 默认处理
  if (key !== 'href') return url
  return /^https?:\/\//i.test(url) ? url : ''
}

const components: Components = {
  img: () => null,
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
