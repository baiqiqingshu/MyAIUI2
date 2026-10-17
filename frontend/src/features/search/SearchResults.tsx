import { Link2 } from 'lucide-react'
import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import type { MessagePart } from '../../domain/message'

type SearchResultPart = Extract<MessagePart, { type: 'search-result' }>

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// 搜索结果卡片：外链一律经 Go 侧 OpenExternalURL 打开，不做窗口内跳转。
export function SearchResultCard({ part }: { part: SearchResultPart }) {
  const showToast = useUiStore((s) => s.showToast)

  function openLink() {
    appApi.OpenExternalURL(part.url).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      showToast(`无法打开链接：${message}`, 'error')
    })
  }

  return (
    <a
      className="search-card"
      href={part.url}
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault()
        openLink()
      }}
    >
      <span className="search-card__head">
        <span className="search-card__title">{part.title || part.url}</span>
        <Link2 size={12} />
      </span>
      <span className="search-card__host">{hostOf(part.url)}</span>
      {part.snippet ? <span className="search-card__snippet">{part.snippet}</span> : null}
    </a>
  )
}
