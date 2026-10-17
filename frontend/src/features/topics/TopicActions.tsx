import { useState, type DragEvent } from 'react'
import clsx from 'clsx'
import { Copy, Download, GitBranch, Pencil, Star, Trash2 } from 'lucide-react'
import { appApi } from '../../bridge/appApi'
import type { TopicDTO } from '../../domain/dto'
import { useUiStore } from '../../app/uiStore'
import { ConfirmDialog, IconButton, Spinner } from '../../components/ui'
import { formatDateTime, formatRelative } from './time'

/** 拖拽落点提示：在目标行上方/下方插入。 */
export type TopicDropPos = 'before' | 'after' | null

/** 单个话题行：激活/分支/生成中标记/相对时间；hover 显示收藏/复制/导出/重命名/删除。
 *  重命名走内联输入（Enter 提交）。拖拽事件由外层（TopicPanel 目录树）注入。 */
export function TopicRow({
  topic,
  active,
  running = false,
  dropPos = null,
  indent,
  selectable = false,
  checked = false,
  onCheckedChange,
  onSelect,
  onRequestDelete,
  onRequestExport,
  onToggleFavorite,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  topic: TopicDTO
  active: boolean
  /** chatStore 契约：该话题正在生成回复时显示转圈标记 */
  running?: boolean
  /** 拖拽落点高亮（上/下半区插入线） */
  dropPos?: TopicDropPos
  /** 目录树层级缩进（px），0/undefined 用默认 padding */
  indent?: number
  /** 批量管理多选态：行首显示 checkbox，禁用拖拽并隐藏行内操作 */
  selectable?: boolean
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  onSelect: (topicId: string) => void
  onRequestDelete: (topic: TopicDTO) => void
  onRequestExport: (topic: TopicDTO) => void
  onToggleFavorite: (topic: TopicDTO) => void
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd?: (event: DragEvent<HTMLDivElement>) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
}) {
  const refreshTopics = useUiStore((s) => s.refreshTopics)
  const selectTopic = useUiStore((s) => s.selectTopic)
  const showToast = useUiStore((s) => s.showToast)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(topic.Title)
  const [saving, setSaving] = useState(false)
  const [duplicating, setDuplicating] = useState(false)

  // 复制为新会话：Go 侧把当前活动分支的完整路径复制成新话题，随后切到副本。
  async function handleDuplicate() {
    setDuplicating(true)
    try {
      const created = await appApi.DuplicateTopic(topic.ID)
      await refreshTopics()
      selectTopic(created.ID)
      showToast('已复制为新会话', 'success')
    } catch (err) {
      showToast(`复制失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setDuplicating(false)
    }
  }

  function startRename() {
    setDraft(topic.Title)
    setEditing(true)
  }

  async function submitRename() {
    const title = draft.trim()
    if (!title || title === topic.Title) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await appApi.RenameTopic(topic.ID, title)
      await refreshTopics()
      setEditing(false)
    } catch (err) {
      // 失败时保留输入框，便于重试
      showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const rowTitle = `${topic.Title || '新话题'}\n创建于 ${formatDateTime(topic.CreatedAt)} · 更新于 ${formatDateTime(topic.UpdatedAt)}`

  return (
    <div
      className={clsx(
        'topic-item',
        active && 'is-active',
        dropPos && `is-drop-${dropPos}`,
        selectable && 'is-selectable',
      )}
      style={indent ? { paddingLeft: indent } : undefined}
      draggable={!editing && !selectable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {selectable ? (
        <input
          type="checkbox"
          className="topic-item__check"
          checked={checked}
          aria-label={`选择话题 ${topic.Title || '新话题'}`}
          onChange={(event) => onCheckedChange?.(event.target.checked)}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      {editing ? (
        <input
          className="ui-input topic-item__input"
          value={draft}
          autoFocus
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(false)
            }
          }}
          onBlur={() => {
            if (!saving) setEditing(false)
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="topic-item__main"
            title={rowTitle}
            onClick={() => {
              // 多选态下点击行主体 = 切换勾选；普通态 = 选中话题
              if (selectable) onCheckedChange?.(!checked)
              else onSelect(topic.ID)
            }}
          >
            <span className="topic-item__titleline">
              {topic.HasBranches ? (
                <span
                  className="topic-item__branch"
                  title="该话题包含分支"
                  aria-label="该话题包含分支"
                >
                  <GitBranch size={12} />
                </span>
              ) : null}
              {topic.Title || '新话题'}
            </span>
            <span className="topic-item__meta">
              {running ? (
                <span className="topic-item__running" title="正在生成回复" aria-label="正在生成回复">
                  <Spinner size={11} />
                </span>
              ) : null}
              <span className="topic-item__time">{formatRelative(topic.UpdatedAt)}</span>
            </span>
          </button>
          {selectable ? null : (
            <span className="topic-item__actions">
              <IconButton
                title={topic.Favorite ? '取消收藏' : '收藏'}
                className={clsx('topic-item__star', topic.Favorite && 'is-fav')}
                onClick={() => onToggleFavorite(topic)}
              >
                <Star size={14} fill={topic.Favorite ? 'currentColor' : 'none'} />
              </IconButton>
              <IconButton title="复制为新会话" onClick={handleDuplicate} disabled={duplicating}>
                <Copy size={14} />
              </IconButton>
              <IconButton title="导出 Markdown" onClick={() => onRequestExport(topic)}>
                <Download size={14} />
              </IconButton>
              <IconButton title="重命名" onClick={startRename}>
                <Pencil size={14} />
              </IconButton>
              <IconButton title="删除" onClick={() => onRequestDelete(topic)}>
                <Trash2 size={14} />
              </IconButton>
            </span>
          )}
        </>
      )}
    </div>
  )
}

/** 删除话题确认框；topic 为 null 时不显示。 */
export function TopicDeleteConfirm({
  topic,
  onClose,
}: {
  topic: TopicDTO | null
  onClose: () => void
}) {
  const refreshTopics = useUiStore((s) => s.refreshTopics)
  const showToast = useUiStore((s) => s.showToast)
  const [busy, setBusy] = useState(false)

  async function handleConfirm() {
    if (!topic) return
    setBusy(true)
    try {
      await appApi.DeleteTopic(topic.ID)
      await refreshTopics()
      showToast('话题已删除', 'success')
      onClose()
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={topic !== null}
      title="删除话题"
      description={topic ? `将删除「${topic.Title || '新话题'}」及其全部消息，且不可撤销。` : undefined}
      confirmText={busy ? '删除中…' : '删除'}
      onConfirm={handleConfirm}
      onCancel={onClose}
    />
  )
}
