import { useEffect, useMemo, useState, type RefObject } from 'react'
import clsx from 'clsx'
import { messageText } from '../../domain/message'
import type { MessageDTO } from '../../domain/dto'
import { EMPTY_SESSION, useChatStore } from './chatStore'

/* 消息区右缘的小点导航：每条持久化消息一个圆点，悬停出预览浮层，
   点击平滑滚动到对应消息行（行锚点是 MessageItem 上的 data-mid）。
   只读会话数据，不改任何流程。 */

const PREVIEW_LEN = 60
const MIN_DOT_COUNT = 2

export interface MessageDotsProps {
  /** 消息滚动容器（.chat-scroll）：IntersectionObserver 的 root 与滚动定位目标 */
  scrollRef: RefObject<HTMLDivElement | null>
}

interface DotItem {
  id: string
  user: boolean
  roleLabel: string
  preview: string
}

function previewOf(message: MessageDTO): string {
  const text = messageText(message).replace(/\s+/g, ' ').trim()
  if (!text) return '（无文本内容）'
  return text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text
}

function rowSelector(id: string): string {
  // 消息 ID 由后端生成（uuid 形态），CSS.escape 兜底非典型字符
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id
  return `[data-mid="${escaped}"]`
}

export function MessageDots({ scrollRef }: MessageDotsProps) {
  const messages = useChatStore(
    (s) => s.sessions[s.activeTopicId]?.messages ?? EMPTY_SESSION.messages,
  )
  const [activeId, setActiveId] = useState('')

  const dots = useMemo<DotItem[]>(
    () =>
      messages.map((m) => ({
        id: m.ID,
        user: m.Role === 'user',
        roleLabel: m.Role === 'user' ? '我' : '助手',
        preview: previewOf(m),
      })),
    [messages],
  )

  /* 视口内最靠上的消息行对应的圆点加 active 态。
     用 IO 维护「当前可见行」集合，回调发生时再实测一次 top 取最小，
     避免直接用 entry.boundingClientRect（回调后滚动期间数值会变旧）。 */
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const visible = new Set<Element>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target)
          else visible.delete(entry.target)
        }
        let topId = ''
        let topY = Infinity
        visible.forEach((el) => {
          const y = el.getBoundingClientRect().top
          if (y < topY) {
            topY = y
            topId = el.getAttribute('data-mid') ?? ''
          }
        })
        setActiveId(topId)
      },
      { root },
    )
    root.querySelectorAll('[data-mid]').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [scrollRef, messages])

  if (dots.length < MIN_DOT_COUNT) return null

  const jump = (id: string) => {
    scrollRef.current
      ?.querySelector(rowSelector(id))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <nav className="chat-dots" aria-label="消息导航">
      {dots.map((dot) => (
        <button
          key={dot.id}
          type="button"
          className={clsx(
            'chat-dots__dot',
            dot.user && 'is-user',
            dot.id === activeId && 'is-active',
          )}
          aria-label={`${dot.roleLabel}：${dot.preview}`}
          onClick={() => jump(dot.id)}
        >
          <span className="chat-dots__preview" role="tooltip" aria-hidden="true">
            <span className="chat-dots__preview-role">{dot.roleLabel}</span>
            <span className="chat-dots__preview-text">{dot.preview}</span>
          </span>
        </button>
      ))}
    </nav>
  )
}
