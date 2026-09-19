import { useEffect, useRef, type ReactNode } from 'react'
import { parseParts } from '../../domain/message'
import type { MessageDTO } from '../../domain/dto'
import { Spinner } from '../../components/ui'
import { MessageItem } from './MessageItem'
import type { StreamState } from './chatStore'

export interface MessageListProps {
  messages: MessageDTO[]
  loading: boolean
  stream: StreamState | null
  canRegenerate: boolean
  onCopy: (text: string) => void
  onRegenerate: (messageId: string) => void
  empty: ReactNode
}

export function MessageList({
  messages,
  loading,
  stream,
  canRegenerate,
  onCopy,
  onRegenerate,
  empty,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // 新消息/流式增量到达时贴底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, stream, loading])

  const last = messages[messages.length - 1]
  const regenerateId = last && last.Role === 'assistant' ? last.ID : ''

  return (
    <div className="chat-scroll scroll-area" ref={scrollRef}>
      {loading ? (
        <div className="chat-loading">
          <Spinner size={14} />
          <span>正在加载消息…</span>
        </div>
      ) : null}
      {!loading && messages.length === 0 ? <div className="chat-empty">{empty}</div> : null}
      <div className="chat-list">
        {messages.map((message) => {
          const isStreaming = !!stream && stream.messageId === message.ID
          const parts = isStreaming && stream ? [...stream.prefix, ...stream.parts] : parseParts(message.PartsJSON)
          return (
            <MessageItem
              key={message.ID}
              message={message}
              parts={parts}
              streaming={isStreaming}
              showRegenerate={canRegenerate && message.ID === regenerateId}
              onCopy={onCopy}
              onRegenerate={onRegenerate}
            />
          )
        })}
      </div>
    </div>
  )
}
