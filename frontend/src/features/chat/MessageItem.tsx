import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { Button, Spinner, Textarea } from '../../components/ui'
import { collectSubtreeIds, partsToText, type MessagePart } from '../../domain/message'
import type { MessageDTO } from '../../domain/dto'
import { useChatStore } from './chatStore'
import { SearchResultCard } from '../search/SearchResults'
import { ImageResult } from '../images/ImageResult'
import { MarkdownText } from './markdown/MarkdownText'

/** 兄弟变体导航：同一父节点下的其它版本。 */
export interface SiblingNavProps {
  count: number
  index: number
  onPrev: () => void
  onNext: () => void
}

export interface MessageItemProps {
  message: MessageDTO
  parts: MessagePart[]
  streaming: boolean
  siblings: SiblingNavProps | null
  canRegenerate: boolean
  onCopy: (text: string) => void
  onRegenerate: (messageId: string) => void
  /** 编辑并重新发送；返回 false 表示失败，需停留在编辑态 */
  onEdit: (messageId: string, text: string) => Promise<boolean> | void
  editDisabled: boolean
  /** 批量管理态：行首渲染勾选框、隐藏行内操作（缺省＝普通态，UI 零变化） */
  selectMode?: boolean
  /** 已勾选的消息 ID 集合（含被连带勾选的不可见后代） */
  checkedSet?: ReadonlySet<string>
  onToggleCheck?: (messageId: string) => void
}

export function MessageItem({
  message,
  parts,
  streaming,
  siblings,
  canRegenerate,
  onCopy,
  onRegenerate,
  onEdit,
  editDisabled,
  selectMode,
  checkedSet,
  onToggleCheck,
}: MessageItemProps) {
  const isUser = message.Role === 'user'
  const text = partsToText(parts)
  const generatingPlaceholder = !isUser && message.Status === 'streaming' && parts.length === 0

  // 删除与生成互斥：流式行/生成中不提供勾选框与删除按钮。
  const generating = useChatStore((s) => s.sessions[s.activeTopicId]?.generating ?? false)
  const deleteMessages = useChatStore((s) => s.deleteMessages)
  const selectable = !!selectMode && !streaming && message.Status !== 'streaming'

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [submitting, setSubmitting] = useState(false)
  const editRef = useRef<HTMLDivElement>(null)
  const lastTextRef = useRef(text)

  // 消息文本变化（切到了别的变体）时退出编辑态，避免把过期文本提交出去。
  // 只有编辑框打开时才动状态：流式过程中 text 每个增量都会变，若无条件 setState，
  // 高频分片会让 React 判定为嵌套更新循环（Maximum update depth exceeded）。
  useEffect(() => {
    if (lastTextRef.current === text) return
    lastTextRef.current = text
    if (!editing) return
    setEditing(false)
    setDraft(text)
  }, [text, editing])

  // 生成中不允许编辑
  useEffect(() => {
    if (editDisabled) setEditing(false)
  }, [editDisabled])

  // Textarea 原语不转发 ref，只能从容器里取实际节点来聚焦并把光标放到末尾
  useEffect(() => {
    if (!editing) return
    const el = editRef.current?.querySelector('textarea')
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const submitEdit = async () => {
    const next = draft.trim()
    if (!next || submitting) return
    setSubmitting(true)
    try {
      const ok = await onEdit(message.ID, next)
      if (ok !== false) setEditing(false)
    } finally {
      setSubmitting(false)
    }
  }

  const openEdit = () => {
    setDraft(text)
    setEditing(true)
  }

  /* 删除该消息及其全部后代：子树从消息树的 ParentID 链收集，树缺失时只删本节点。 */
  const onDelete = () => {
    const state = useChatStore.getState()
    const nodes = state.sessions[state.activeTopicId]?.tree?.Nodes
    void deleteMessages(collectSubtreeIds(nodes, message.ID))
  }

  return (
    <article
      className={clsx(
        'chat-msg',
        isUser ? 'chat-msg--user' : 'chat-msg--assistant',
        selectMode && 'chat-msg--select',
      )}
      data-mid={message.ID}
    >
      {selectMode ? (
        selectable ? (
          <input
            type="checkbox"
            className="chat-msg__check"
            checked={checkedSet?.has(message.ID) ?? false}
            onChange={() => onToggleCheck?.(message.ID)}
            aria-label="勾选这条消息及其后续分支"
          />
        ) : (
          /* 流式行不可勾选，占位保持行首对齐 */
          <span className="chat-msg__check-spacer" aria-hidden="true" />
        )
      ) : null}
      <div className="chat-msg__body">
        {editing ? (
          <div className="chat-edit" ref={editRef}>
            <Textarea
              value={draft}
              onChange={setDraft}
              rows={3}
              disabled={submitting}
              className="chat-edit__input"
              placeholder="修改后重新发送"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(false)
                  return
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submitEdit()
                }
              }}
            />
            <div className="chat-edit__foot">
              <span className="chat-edit__hint">Enter 发送，Shift+Enter 换行，Esc 取消</span>
              <Button size="sm" onClick={() => setEditing(false)} disabled={submitting}>
                取消
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={submitting}
                disabled={!draft.trim()}
                onClick={() => {
                  void submitEdit()
                }}
              >
                发送
              </Button>
            </div>
          </div>
        ) : generatingPlaceholder ? (
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
      {editing || selectMode ? null : (
        <div className="chat-msg__actions">
          {siblings && siblings.count > 1 ? (
            <span className="chat-msg__siblings" title="切换同一位置的其它版本">
              <button
                type="button"
                className="chat-action chat-action--icon"
                disabled={siblings.index <= 1}
                title="上一个版本"
                onClick={siblings.onPrev}
              >
                <ChevronLeft size={13} />
              </button>
              <span className="chat-msg__siblings-count">
                {siblings.index}/{siblings.count}
              </span>
              <button
                type="button"
                className="chat-action chat-action--icon"
                disabled={siblings.index >= siblings.count}
                title="下一个版本"
                onClick={siblings.onNext}
              >
                <ChevronRight size={13} />
              </button>
            </span>
          ) : null}
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
          {isUser && !editDisabled ? (
            <button
              type="button"
              className="chat-action"
              disabled={!text}
              title="编辑并重新发送"
              onClick={openEdit}
            >
              <Pencil size={13} />
              <span>编辑</span>
            </button>
          ) : null}
          {!isUser && canRegenerate ? (
            <button
              type="button"
              className="chat-action"
              title="重新生成（保留当前回答作为另一版本）"
              onClick={() => onRegenerate(message.ID)}
            >
              <RefreshCw size={13} />
              <span>重新生成</span>
            </button>
          ) : null}
          {!generating ? (
            <button
              type="button"
              className="chat-action"
              title="删除这条消息及其后续分支"
              onClick={onDelete}
            >
              <Trash2 size={13} />
              <span>删除</span>
            </button>
          ) : null}
        </div>
      )}
    </article>
  )
}

function PartView({ part, streaming }: { part: MessagePart; streaming: boolean }) {
  switch (part.type) {
    case 'text':
      return <MarkdownText text={part.text} streaming={streaming} />
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
