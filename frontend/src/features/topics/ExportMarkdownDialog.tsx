import { useEffect, useState } from 'react'
import { appApi } from '../../bridge/appApi'
import type { MarkdownExportDTO, TopicDTO } from '../../domain/dto'
import { useUiStore } from '../../app/uiStore'
import { Button, Modal, Spinner } from '../../components/ui'
import { copyToClipboard } from '../chat/chatStore'
import './topics.css'

/** 预览长度上限：超出只影响预览，复制/保存的始终是 Go 生成的完整文本。 */
const PREVIEW_LIMIT = 4000

/** 导出为 Markdown：Markdown 文本由 Go 生成，前端只负责预览、复制与另存为。 */
export function ExportMarkdownDialog({
  topic,
  onClose,
}: {
  topic: TopicDTO | null
  onClose: () => void
}) {
  const showToast = useUiStore((s) => s.showToast)
  const [data, setData] = useState<MarkdownExportDTO | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  // 重试计数：变化时驱动下面的 effect 重新拉取
  const [reloadKey, setReloadKey] = useState(0)

  const topicId = topic?.ID ?? ''

  useEffect(() => {
    if (!topicId) return
    // 弹窗关闭（topic 变空）或切换话题后，旧请求的结果直接丢弃
    let alive = true
    setLoading(true)
    setError('')
    setData(null)
    appApi
      .ExportTopicMarkdown(topicId)
      .then((result) => {
        if (alive) setData(result)
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [topicId, reloadKey])

  async function handleSave() {
    // 对话框是模态的：连点两次会开出两个原生对话框（并可能让 Wails 崩溃），这里直接挡住第二次。
    if (!topic || !data || saving) return
    setSaving(true)
    try {
      const result = await appApi.SaveTopicMarkdown(topic.ID, data.FileName)
      if (result.Saved) {
        showToast(`已保存：${result.FileName || data.FileName}`, 'success')
      } else {
        showToast('已取消保存', 'info')
      }
    } catch (err) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const markdown = data?.Markdown ?? ''
  const truncated = markdown.length > PREVIEW_LIMIT

  return (
    <Modal
      open={topic !== null}
      title="导出为 Markdown"
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button
            onClick={() => {
              if (data) void copyToClipboard(data.Markdown)
            }}
            disabled={!data || saving}
          >
            复制到剪贴板
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!data || !topic}
          >
            另存为 .md 文件
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="export-dialog__status">
          <Spinner size={16} />
          <span>正在生成 Markdown…</span>
        </div>
      ) : error ? (
        <div className="export-dialog__status is-error">
          <div className="export-dialog__error">生成失败：{error}</div>
          <Button size="sm" onClick={() => setReloadKey((n) => n + 1)}>
            重试
          </Button>
        </div>
      ) : data ? (
        <>
          <div className="export-dialog__meta">
            <span className="export-dialog__filename" title={data.FileName}>
              {data.FileName}
            </span>
            <span className="export-dialog__count">{data.MessageCount} 条消息（当前分支）</span>
          </div>
          <pre className="export-dialog__preview">
            {truncated ? markdown.slice(0, PREVIEW_LIMIT) : markdown}
          </pre>
          {truncated ? (
            <p className="export-dialog__hint">预览已截断，复制/保存的是完整内容</p>
          ) : null}
        </>
      ) : null}
    </Modal>
  )
}
