import { Copy, RefreshCw } from 'lucide-react'
import { Spinner } from '../../components/ui'
import { partsToText, type MessagePart } from '../../domain/message'
import type { MessageDTO } from '../../domain/dto'
import { SearchResultCard } from '../search/SearchResults'
import { ImageResult } from '../images/ImageResult'
import { MarkdownText } from './markdown/MarkdownText'

export interface MessageItemProps {
  message: MessageDTO
  parts: MessagePart[]
  streaming: boolean
  showRegenerate: boolean
  onCopy: (text: string) => void
  onRegenerate: (messageId: string) => void
}

export function MessageItem({
  message,
  parts,
  streaming,
  showRegenerate,
  onCopy,
  onRegenerate,
}: MessageItemProps) {
  const isUser = message.Role === 'user'
  const text = partsToText(parts)
  const generatingPlaceholder = !isUser && message.Status === 'streaming' && parts.length === 0

  return (
    <article className={isUser ? 'chat-msg chat-msg--user' : 'chat-msg chat-msg--assistant'}>
      <div className="chat-msg__body">
        {generatingPlaceholder ? (
          <div className="chat-typing">
            <Spinner size={14} />
            <span>正在生成…</span>
          </div>
        ) : isUser ? (
          <div className="chat-msg__text">{text}</div>
        ) : parts.length === 0 ? (
          <div className="chat-msg__status">没有内容</div>
        ) : (
          <div className="chat-msg__parts">
            {parts.map((part, index) => (
              <PartView key={`${part.type}-${index}`} part={part} streaming={streaming} />
            ))}
          </div>
        )}
        {message.Status === 'interrupted' ? (
          <div className="chat-msg__status">生成被中断（应用重启导致）</div>
        ) : null}
        {message.Status === 'cancelled' && !streaming ? <div className="chat-msg__status">已停止</div> : null}
      </div>
      <div className="chat-msg__actions">
        <button
          type="button"
          className="chat-action"
          disabled={!text}
          title="复制文本"
          onClick={() => onCopy(text)}
        >
          <Copy size={13} />
          <span>复制</span>
        </button>
        {showRegenerate ? (
          <button
            type="button"
            className="chat-action"
            title="重新生成"
            onClick={() => onRegenerate(message.ID)}
          >
            <RefreshCw size={13} />
            <span>重新生成</span>
          </button>
        ) : null}
      </div>
    </article>
  )
}

function PartView({ part, streaming }: { part: MessagePart; streaming: boolean }) {
  switch (part.type) {
    case 'text':
      return <MarkdownText text={part.text} />
    case 'reasoning':
      return (
        <details className="chat-reasoning" open={streaming}>
          <summary>思考过程</summary>
          <div className="chat-reasoning__body">{part.text}</div>
        </details>
      )
    case 'search-result':
      return <SearchResultCard part={part} />
    case 'image':
      return <ImageResult part={part} />
    case 'error':
      return (
        <div className="chat-error-card">
          <div className="chat-error-card__title">生成失败</div>
          <div className="chat-error-card__message">{part.message}</div>
          <div className="chat-error-card__code">{part.code}</div>
        </div>
      )
  }
}
