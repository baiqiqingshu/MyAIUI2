import { useEffect, useRef, type ReactNode } from 'react'
import { parseParts } from '../../domain/message'
import type { MessageDTO } from '../../domain/dto'
import { Spinner } from '../../components/ui'
import { MessageItem } from './MessageItem'
import { useChatStore, type StreamState } from './chatStore'

export interface MessageListProps {
  messages: MessageDTO[]
  loading: boolean
  stream: StreamState | null
  canRegenerate: boolean
  onCopy: (text: string) => void
  onRegenerate: (messageId: string) => void
  onEdit: (messageId: string, text: string) => Promise<boolean> | void
  editDisabled: boolean
  empty: ReactNode
}

export function MessageList({
  messages,
  loading,
  stream,
  canRegenerate,
  onCopy,
  onRegenerate,
  onEdit,
  editDisabled,
  empty,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // 兄弟变体信息来自消息树：无树或该位置只有一个版本时返回 null
  const siblingsFor = useChatStore((s) => s.siblingsFor)

  // 新消息/流式增量到达时贴底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, stream, loading])

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
              siblings={siblingsFor(message.ID)}
              canRegenerate={canRegenerate && message.Role !== 'user'}
              onCopy={onCopy}
              onRegenerate={onRegenerate}
              onEdit={onEdit}
              editDisabled={editDisabled}
            />
          )
        })}
      </div>
    </div>
  )
}
