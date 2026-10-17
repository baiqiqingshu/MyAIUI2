import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
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
  /** 批量管理态：行首渲染勾选框、隐藏行内操作（缺省＝普通态，UI 零变化） */
  selectMode?: boolean
  /** 已勾选的消息 ID 集合（含被连带勾选的不可见后代） */
  checkedSet?: ReadonlySet<string>
  onToggleCheck?: (messageId: string) => void
  empty: ReactNode
  /** 可选：外部传入滚动容器 ref（如 MessageDots 需要共享容器做观察/滚动定位）；
      缺省用内部 ref，贴底逻辑不变。 */
  scrollRef?: RefObject<HTMLDivElement | null>
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
  selectMode,
  checkedSet,
  onToggleCheck,
  empty,
  scrollRef: externalScrollRef,
}: MessageListProps) {
  const internalScrollRef = useRef<HTMLDivElement>(null)
  const scrollRef = externalScrollRef ?? internalScrollRef
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
          const parts = isStreaming && stream ? stream.parts : parseParts(message.PartsJSON)
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
              selectMode={selectMode}
              checkedSet={checkedSet}
              onToggleCheck={onToggleCheck}
            />
          )
        })}
      </div>
    </div>
  )
}
