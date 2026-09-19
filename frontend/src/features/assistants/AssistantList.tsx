import { Globe, Pencil, Plus, Server } from 'lucide-react'
import clsx from 'clsx'
import { useUiStore } from '../../app/uiStore'
import { IconButton } from '../../components/ui'
import './assistants.css'

/** 最左侧 64px 助手栏：Emoji 头像列表 + 底部三个入口。 */
export function AssistantRail() {
  const assistants = useUiStore((s) => s.assistants)
  const activeAssistantId = useUiStore((s) => s.activeAssistantId)
  const selectAssistant = useUiStore((s) => s.selectAssistant)
  const openDrawer = useUiStore((s) => s.openDrawer)

  return (
    <aside className="as-rail" aria-label="助手">
      <div className="as-rail__list scroll-area">
        {assistants.map((assistant) => {
          const active = assistant.ID === activeAssistantId
          return (
            <div key={assistant.ID} className="as-rail__cell">
              <button
                type="button"
                className={clsx('as-rail__item', active && 'is-active')}
                title={assistant.Name}
                aria-label={assistant.Name}
                aria-current={active ? 'true' : undefined}
                onClick={() => selectAssistant(assistant.ID)}
              >
                <span className="as-rail__emoji">{assistant.Emoji || '🤖'}</span>
              </button>
              <button
                type="button"
                className="as-rail__edit"
                title={`编辑助手：${assistant.Name}`}
                aria-label={`编辑助手：${assistant.Name}`}
                onClick={() => openDrawer({ kind: 'assistant', assistantId: assistant.ID })}
              >
                <Pencil size={11} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="as-rail__foot">
        <IconButton
          title="添加助手"
          onClick={() => openDrawer({ kind: 'assistant', assistantId: '' })}
        >
          <Plus size={18} />
        </IconButton>
        <IconButton title="模型服务" onClick={() => openDrawer({ kind: 'providers' })}>
          <Server size={18} />
        </IconButton>
        <IconButton title="联网搜索" onClick={() => openDrawer({ kind: 'search' })}>
          <Globe size={18} />
        </IconButton>
      </div>
    </aside>
  )
}
