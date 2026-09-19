import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { appApi } from '../../bridge/appApi'
import type { TopicDTO } from '../../domain/dto'
import { useUiStore } from '../../app/uiStore'
import { ConfirmDialog, IconButton } from '../../components/ui'

/** 单个话题行：hover 显示重命名/删除，重命名走内联输入（Enter 提交）。 */
export function TopicRow({
  topic,
  active,
  onSelect,
  onRequestDelete,
}: {
  topic: TopicDTO
  active: boolean
  onSelect: (topicId: string) => void
  onRequestDelete: (topic: TopicDTO) => void
}) {
  const refreshTopics = useUiStore((s) => s.refreshTopics)
  const showToast = useUiStore((s) => s.showToast)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(topic.Title)
  const [saving, setSaving] = useState(false)

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

  return (
    <div className={active ? 'topic-item is-active' : 'topic-item'}>
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
            title={topic.Title || '新话题'}
            onClick={() => onSelect(topic.ID)}
          >
            {topic.Title || '新话题'}
          </button>
          <span className="topic-item__actions">
            <IconButton title="重命名" onClick={startRename}>
              <Pencil size={14} />
            </IconButton>
            <IconButton title="删除" onClick={() => onRequestDelete(topic)}>
              <Trash2 size={14} />
            </IconButton>
          </span>
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
