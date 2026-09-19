import { useState } from 'react'
import { Plus } from 'lucide-react'
import { appApi } from '../../bridge/appApi'
import type { TopicDTO } from '../../domain/dto'
import { useUiStore } from '../../app/uiStore'
import { EmptyState, IconButton } from '../../components/ui'
import { ExportMarkdownDialog } from './ExportMarkdownDialog'
import { TopicDeleteConfirm, TopicRow } from './TopicActions'
import './topics.css'

/** 第二栏话题面板：新建 / 切换 / 复制 / 导出 / 重命名 / 删除。 */
export function TopicPanel() {
  const activeAssistantId = useUiStore((s) => s.activeAssistantId)
  const activeTopicId = useUiStore((s) => s.activeTopicId)
  const topics = useUiStore((s) => s.topics)
  const selectTopic = useUiStore((s) => s.selectTopic)
  const refreshTopics = useUiStore((s) => s.refreshTopics)
  const showToast = useUiStore((s) => s.showToast)
  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<TopicDTO | null>(null)
  const [pendingExport, setPendingExport] = useState<TopicDTO | null>(null)

  async function handleCreate() {
    if (!activeAssistantId) {
      showToast('请先选择一个助手', 'error')
      return
    }
    setCreating(true)
    try {
      const created = await appApi.CreateTopic({ AssistantID: activeAssistantId, Title: '' })
      await refreshTopics()
      selectTopic(created.ID)
    } catch (err) {
      showToast(`新建话题失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <aside className="topic-panel" aria-label="话题">
      <header className="topic-panel__head">
        <span className="topic-panel__title">话题</span>
        <IconButton
          title="新建话题"
          onClick={handleCreate}
          disabled={creating || !activeAssistantId}
        >
          <Plus size={16} />
        </IconButton>
      </header>

      <div className="topic-panel__list scroll-area">
        {topics.map((topic) => (
          <TopicRow
            key={topic.ID}
            topic={topic}
            active={topic.ID === activeTopicId}
            onSelect={selectTopic}
            onRequestDelete={setPendingDelete}
            onRequestExport={setPendingExport}
          />
        ))}
        {topics.length === 0 ? (
          <EmptyState title="暂无话题" description="点击右上角「+」新建一个话题" />
        ) : null}
      </div>

      <TopicDeleteConfirm topic={pendingDelete} onClose={() => setPendingDelete(null)} />
      <ExportMarkdownDialog topic={pendingExport} onClose={() => setPendingExport(null)} />
    </aside>
  )
}
