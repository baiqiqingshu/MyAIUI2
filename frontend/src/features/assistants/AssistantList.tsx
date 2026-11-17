import { Bot, MessageSquare, Pencil, Plus, Server } from 'lucide-react'
import clsx from 'clsx'
import { useUiStore } from '../../app/uiStore'
import { IconButton } from '../../components/ui'
import './assistants.css'

/** 最左侧 64px 助手栏：Emoji 头像列表 + 底部三个入口（添加助手 / 聊天 / 模型服务）。 */
export function AssistantRail() {
  const assistants = useUiStore((s) => s.assistants)
  const activeAssistantId = useUiStore((s) => s.activeAssistantId)
  const selectAssistant = useUiStore((s) => s.selectAssistant)
  const openDrawer = useUiStore((s) => s.openDrawer)
  const mainView = useUiStore((s) => s.mainView)
  const setMainView = useUiStore((s) => s.setMainView)

  return (
    <aside className="as-rail" aria-label="助手">
      {/* 品牌块：全局仅有的两处渐变位之一（另一处是头像列的选中指示条），纯装饰 */}
      <div className="as-rail__brand" aria-hidden="true">
        <span className="as-rail__brand-mark">
          <Bot size={18} />
        </span>
      </div>
      <div className="as-rail__list scroll-area">
        {assistants.map((assistant) => {
          const active = assistant.ID === activeAssistantId
          return (
            <div key={assistant.ID} className={clsx('as-rail__cell', active && 'is-active')}>
              <button
                type="button"
                className={clsx('as-rail__item', active && 'is-active')}
                title={assistant.Name}
                aria-label={assistant.Name}
                aria-current={active ? 'true' : undefined}
                onClick={() => {
                  selectAssistant(assistant.ID)
                  // 模型服务页里点助手直接切回聊天视图。
                  if (mainView === 'models') setMainView('chat')
                }}
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
        <IconButton title="聊天" active={mainView === 'chat'} onClick={() => setMainView('chat')}>
          <MessageSquare size={18} />
        </IconButton>
        <IconButton
          title="模型服务"
          active={mainView === 'models'}
          onClick={() => setMainView('models')}
        >
          <Server size={18} />
        </IconButton>
      </div>
    </aside>
  )
}
