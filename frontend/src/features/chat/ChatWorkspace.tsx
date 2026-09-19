import { useEffect, useState, type ReactElement } from 'react'
import { PlugZap } from 'lucide-react'
import { Button, EmptyState } from '../../components/ui'
import { useUiStore } from '../../app/uiStore'
import { copyToClipboard, useChatStore } from './chatStore'
import { MessageList } from './MessageList'
import { TextComposer } from './TextComposer'
import './chat.css'

/* 单一对话工作台：顶栏（助手/话题）+ 消息列表 + 纯文本输入器。 */
export function ChatWorkspace(): ReactElement {
  const assistants = useUiStore((s) => s.assistants)
  const topics = useUiStore((s) => s.topics)
  const providers = useUiStore((s) => s.providers)
  const models = useUiStore((s) => s.models)
  const activeAssistantId = useUiStore((s) => s.activeAssistantId)
  const activeTopicId = useUiStore((s) => s.activeTopicId)
  const openDrawer = useUiStore((s) => s.openDrawer)

  const messages = useChatStore((s) => s.messages)
  const loading = useChatStore((s) => s.loading)
  const generating = useChatStore((s) => s.generating)
  const stream = useChatStore((s) => s.stream)
  const setTopic = useChatStore((s) => s.setTopic)
  const send = useChatStore((s) => s.send)
  const regenerate = useChatStore((s) => s.regenerate)
  const syncSearchDefault = useChatStore((s) => s.syncSearchDefault)

  const assistant = assistants.find((a) => a.ID === activeAssistantId)
  const topic = topics.find((t) => t.ID === activeTopicId)
  const hasEnabledModel = models.some((m) => m.Enabled)

  const [draft, setDraft] = useState('')

  useEffect(() => {
    setTopic(activeTopicId)
  }, [activeTopicId, setTopic])

  useEffect(() => {
    setDraft('')
  }, [activeTopicId])

  useEffect(() => {
    syncSearchDefault(assistant?.WebSearchDefault ?? false)
  }, [assistant?.ID, assistant?.WebSearchDefault, syncSearchDefault])

  const openProviders = () => openDrawer({ kind: 'providers' })
  const providerGuide = !hasEnabledModel

  return (
    <div className="chat">
      <header className="chat-header">
        <span className="chat-header__emoji" aria-hidden>
          {assistant?.Emoji || '🤖'}
        </span>
        <div className="chat-header__meta">
          <div className="chat-header__name">{assistant?.Name || '未选择助手'}</div>
          <div className="chat-header__topic" title={topic?.Title}>
            {topic?.Title || '未选择话题'}
          </div>
        </div>
      </header>

      <MessageList
        messages={messages}
        loading={loading}
        stream={stream}
        canRegenerate={!generating && hasEnabledModel}
        onCopy={(text) => {
          void copyToClipboard(text)
        }}
        onRegenerate={(messageId) => {
          void regenerate(messageId)
        }}
        empty={
          !activeTopicId ? (
            <EmptyState title="还没有话题" description="在左侧话题栏新建一个话题，然后开始对话。" />
          ) : providerGuide ? (
            <EmptyState
              icon={<PlugZap size={22} />}
              title={providers.length === 0 ? '还没有配置模型服务' : '没有可用的模型'}
              description={
                providers.length === 0
                  ? '添加一个 OpenAI 兼容的模型服务，同步模型后即可开始对话。'
                  : '请在模型服务中启用或同步模型。'
              }
              action={
                <Button variant="primary" onClick={openProviders}>
                  打开模型服务
                </Button>
              }
            />
          ) : (
            <EmptyState title="开始新的对话" description="输入问题后按 Enter 发送；需要联网时可开启联网开关。" />
          )
        }
      />

      {providerGuide && activeTopicId && messages.length > 0 ? (
        <div className="chat-notice">
          <span>当前没有可用模型，无法继续发送。</span>
          <Button size="sm" onClick={openProviders}>
            打开模型服务
          </Button>
        </div>
      ) : null}

      <TextComposer
        value={draft}
        onChange={setDraft}
        disabled={!activeTopicId || providerGuide}
        onSend={() => {
          const text = draft.trim()
          if (!text) return
          void send(text).then((started) => {
            if (started) setDraft('')
          })
        }}
      />
    </div>
  )
}
